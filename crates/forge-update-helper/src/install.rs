use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    Result, bundle, directory,
    manifest::{METADATA_LIMIT, VerifiedManifest, canonical, lower_hex, stable_version},
    open_regular, read_bounded, write_new,
};

pub const HELPER_VERSION: &str = include_str!("../helper-version.txt").trim_ascii();
const BOOTSTRAP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROJECT_SCHEMA: u32 = 1;
const ACTIVE: &str = "active.json";
const LAUNCHER: &str = "Forge Launcher.exe";
const FIRST_INSTALL: &str = "first-install-slot";
const FIRST_INSTALL_PART: &str = "first-install-slot.part";
const SLOT_TRANSITION: &str = ".forge-install-transition.json";
const SLOT_TRANSITION_SIG: &str = ".forge-install-transition.sig";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Active {
    schema_version: u32,
    pub version: String,
    pub package_sha256: String,
    pub slot: String,
}

impl Active {
    pub(crate) fn check(&self) -> Result<()> {
        stable_version(&self.version)?;
        let parsed = Uuid::parse_str(&self.slot)?;
        if self.schema_version != 1
            || !lower_hex(&self.package_sha256, 64)
            || parsed.is_nil()
            || parsed.to_string() != self.slot
        {
            return Err("Invalid active-slot record".into());
        }
        Ok(())
    }
}

pub fn per_user_root() -> Result<PathBuf> {
    let root =
        PathBuf::from(env::var_os("LOCALAPPDATA").ok_or("Local application data is unavailable")?);
    if !root.is_absolute() {
        return Err("Invalid local application data directory".into());
    }
    Ok(root.join("Forge").join("Installation"))
}

pub fn launcher_root(executable: &Path) -> Result<PathBuf> {
    if executable.file_name() == Some(LAUNCHER.as_ref())
        && let Some(directory) = executable.parent()
        && directory.file_name() == Some("Installation".as_ref())
    {
        return Ok(directory.to_path_buf());
    }
    per_user_root()
}

pub fn helper_root(executable: &Path) -> Result<PathBuf> {
    if let Some(slot) = executable.parent()
        && let Some(slots) = slot.parent()
        && slots.file_name() == Some("slots".as_ref())
        && slot
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                Uuid::parse_str(name).is_ok_and(|id| !id.is_nil() && id.to_string() == name)
            })
        && let Some(installation) = slots.parent()
        && installation.file_name() == Some("Installation".as_ref())
    {
        return Ok(installation.to_path_buf());
    }
    per_user_root()
}

/// A wizard destination is a dedicated Forge directory on a local Windows drive.
/// Reject reparse points before creating or opening any managed file.
pub fn wizard_root(destination: &Path) -> Result<PathBuf> {
    use std::path::Component;
    #[cfg(windows)]
    use std::path::Prefix;

    let mut parts = destination.components();
    #[cfg(windows)]
    if !matches!(parts.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
    {
        return Err("Choose a directory on a local Windows drive".into());
    }
    if parts.next() != Some(Component::RootDir)
        || !parts.all(|part| matches!(part, Component::Normal(_)))
        || !matches!(
            destination.components().next_back(),
            Some(Component::Normal(_))
        )
    {
        return Err("Choose a dedicated Forge folder on a local Windows drive".into());
    }
    let root = destination.join("Installation");
    for part in root.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(_) => directory(part)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(root)
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub fn windows_build() -> Result<u32> {
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
    }

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..OSVERSIONINFOW::default()
    };
    // The pointer and its advertised size both use the SDK layout of OSVERSIONINFOW.
    if unsafe { RtlGetVersion(&mut info) } != 0 || info.dwMajorVersion < 10 {
        return Err("This Windows version could not be verified".into());
    }
    Ok(info.dwBuildNumber)
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
pub fn windows_build() -> Result<u32> {
    Err("Installing Forge requires Windows x64".into())
}

fn directory_or_create(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => directory(path),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn acquire(root: &Path) -> Result<File> {
    let product = root.parent().ok_or("Invalid installation directory")?;
    directory_or_create(product)?;
    directory_or_create(root)?;
    let path = root.join("installation.lock");
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let info = file.metadata()?;
    if !info.is_file() || crate::reparse_point(&info) {
        return Err("Invalid installation lock".into());
    }
    file.try_lock()?;
    crate::reinstall::recover(root)?;
    Ok(file)
}

fn stream_digest(input: &mut File) -> Result<[u8; 32]> {
    let mut hash = Sha256::new();
    io::copy(&mut input.take(64 * 1024 * 1024 + 1), &mut hash)?;
    Ok(hash.finalize().into())
}

fn publish_launcher(root: &Path, source: &Path, slot: &str) -> Result<()> {
    let destination = root.join(LAUNCHER);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            let mut existing = open_regular(&destination)?;
            let mut source = open_regular(source)?;
            if existing.metadata()?.len() > 64 * 1024 * 1024
                || existing.metadata()?.len() != source.metadata()?.len()
                || stream_digest(&mut existing)? != stream_digest(&mut source)?
            {
                return Err("A different Forge launcher is already present".into());
            }
            return Ok(());
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let staging = root.join(format!("launcher-{slot}.part"));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staging)?;
    let result = (|| {
        let mut source = open_regular(source)?;
        if source.metadata()?.len() > 64 * 1024 * 1024 {
            return Err("Forge launcher exceeds its size limit".into());
        }
        io::copy(&mut source, &mut output)?;
        output.sync_all()?;
        drop(output);
        fs::hard_link(&staging, destination)?;
        Ok(())
    })();
    let _ = fs::remove_file(staging);
    result
}

fn remove_bootstrap_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_file() && !crate::reparse_point(&info) => fs::remove_file(path)?,
        Ok(_) => return Err("Invalid first-install temporary file".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

// Called with the installation lock held, before an active pointer exists.
fn begin_first_install(root: &Path) -> Result<Uuid> {
    let pending = root.join(FIRST_INSTALL);
    let draft = root.join(FIRST_INSTALL_PART);
    match fs::symlink_metadata(&pending) {
        Ok(_) => {
            let bytes = read_bounded(&pending, 36)?;
            let saved = std::str::from_utf8(&bytes)?;
            let slot = Uuid::parse_str(saved)?;
            if slot.is_nil() || slot.to_string() != saved {
                return Err("Invalid first-install slot record".into());
            }
            let slots = root.join("slots");
            directory_or_create(&slots)?;
            for path in [slots.join(format!("staging-{slot}")), slots.join(saved)] {
                match fs::symlink_metadata(&path) {
                    Ok(_) => {
                        directory(&path)?;
                        fs::remove_dir_all(path)?;
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            remove_bootstrap_file(&root.join(format!("launcher-{slot}.part")))?;
            remove_bootstrap_file(&root.join(format!("active-{slot}.part")))?;
            fs::remove_file(&pending)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    remove_bootstrap_file(&draft)?;
    let slot = Uuid::new_v4();
    write_new(&draft, slot.to_string().as_bytes())?;
    rename_record(&draft, &pending)?;
    Ok(slot)
}

pub fn first_install(
    root: &Path,
    launcher: &Path,
    package: &Path,
    manifest: &VerifiedManifest,
) -> Result<Active> {
    install(root, launcher, package, manifest, false)
}

pub fn wizard_install(
    destination: &Path,
    launcher: &Path,
    package: &Path,
    manifest: &VerifiedManifest,
) -> Result<Active> {
    let root = wizard_root(destination)?;
    if root.is_dir() && !root.join(ACTIVE).exists() && !root.join(FIRST_INSTALL).exists() {
        for entry in fs::read_dir(&root)? {
            if entry?.file_name() != "installation.lock" {
                return Err("Choose a folder with an unused Forge Installation directory".into());
            }
        }
    }
    fs::create_dir_all(destination)?;
    install(&root, launcher, package, manifest, true)
}

fn install(
    root: &Path,
    launcher: &Path,
    package: &Path,
    manifest: &VerifiedManifest,
    wizard: bool,
) -> Result<Active> {
    manifest.ensure_compatible(HELPER_VERSION, PROJECT_SCHEMA, windows_build()?)?;
    manifest.compare_installed(BOOTSTRAP_VERSION, &manifest.data().artifact.sha256)?;
    let input = bundle::verified_file(package, manifest)?;
    let _guard = acquire(root)?;
    match fs::symlink_metadata(root.join(ACTIVE)) {
        Ok(_) if wizard => {
            let active = active_record(root)?;
            match manifest.compare_installed(&active.version, &active.package_sha256)? {
                std::cmp::Ordering::Equal => {
                    crate::reinstall::replace(root, &active, input, manifest)?;
                    refresh_launcher(root, launcher)?;
                    return Ok(active);
                }
                std::cmp::Ordering::Greater => {
                    let (previous, _, _) = verified_active(root).map_err(|error| {
                        format!("This installer could not verify the existing release with its signing key. Use a build signed for this installation. {error}")
                    })?;
                    return crate::job::install_existing(root, previous, manifest, input, launcher);
                }
                std::cmp::Ordering::Less => unreachable!("compare_installed rejects downgrades"),
            }
        }
        Ok(_) => return Err("Forge is already installed. Use Settings → Updates.".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let slot = begin_first_install(root)?;
    let record = stage_slot(root, input, manifest, slot, Some(launcher))?;
    let pointer = root.join(format!("active-{}.part", record.slot));
    write_new(&pointer, &canonical(&record)?)?;
    let published = fs::hard_link(&pointer, root.join(ACTIVE));
    let _ = fs::remove_file(pointer);
    published?;
    let _ = fs::remove_file(root.join(FIRST_INSTALL));
    Ok(record)
}

pub(crate) fn refresh_launcher(root: &Path, source: &Path) -> Result<()> {
    let bytes = read_bounded(source, 64 * 1024 * 1024)?;
    match read_bounded(&root.join(LAUNCHER), 64 * 1024 * 1024) {
        Ok(current) if current == bytes => return Ok(()),
        Ok(_) => {}
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) => {}
        Err(error) => return Err(error),
    }
    replace_record(root, LAUNCHER, &bytes)
}

pub fn check_uninstall(root: &Path) -> Result<()> {
    let destination = root
        .parent()
        .ok_or("Invalid Forge installation directory")?;
    if wizard_root(destination)? != root {
        return Err("Invalid Forge installation directory".into());
    }
    let _guard = acquire(root)?;
    verified_active(root)?;
    crate::uninstall::check(root)
}

pub fn remove_installation(root: &Path, full: bool) -> Result<()> {
    let product = root
        .parent()
        .ok_or("Invalid Forge installation directory")?;
    if wizard_root(product)? != root {
        return Err("Invalid Forge installation directory".into());
    }
    {
        let _guard = acquire(root)?;
        verified_active(root)?;
        crate::uninstall::prepare_full_removal(product, root)?;
    }
    crate::uninstall::remove_files(product, root, full)
}

pub fn remove_after_exit(root: &Path, pid: u32) -> Result<()> {
    crate::uninstall::after_exit(root, pid)
}

pub(crate) fn stage_slot(
    root: &Path,
    input: File,
    manifest: &VerifiedManifest,
    slot: Uuid,
    launcher: Option<&Path>,
) -> Result<Active> {
    let slots = root.join("slots");
    directory_or_create(&slots)?;
    let slot = slot.to_string();
    let staging = slots.join(format!("staging-{slot}"));
    fs::create_dir(&staging)?;
    let result = (|| {
        bundle::extract(input, &staging, manifest)?;
        write_new(
            &staging.join(".forge-install-manifest.json"),
            &canonical(manifest.data())?,
        )?;
        write_new(
            &staging.join(".forge-install-manifest.sig"),
            manifest.signature(),
        )?;
        if let Some((body, signature)) = manifest.transition() {
            write_new(&staging.join(SLOT_TRANSITION), body)?;
            write_new(&staging.join(SLOT_TRANSITION_SIG), signature)?;
        }
        let record = Active {
            schema_version: 1,
            version: manifest.data().version.clone(),
            package_sha256: manifest.data().artifact.sha256.clone(),
            slot: slot.clone(),
        };
        if let Some(launcher) = launcher {
            publish_launcher(root, launcher, &slot)?;
        }
        fs::rename(&staging, slots.join(&slot))?;
        Ok(record)
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

pub(crate) fn active_record(root: &Path) -> Result<Active> {
    directory(root)?;
    let mut input = Vec::new();
    crate::open_with_sharing(&root.join(ACTIVE), true)?
        .take(4097)
        .read_to_end(&mut input)?;
    if input.len() > 4096 {
        return Err("Active slot record exceeds its size limit".into());
    }
    let record: Active = serde_json::from_slice(&input)?;
    record.check()?;
    Ok(record)
}

fn slot_path(root: &Path, record: &Active) -> Result<PathBuf> {
    record.check()?;
    let slots = root.join("slots");
    directory(&slots)?;
    let path = slots.join(&record.slot);
    directory(&path)?;
    if bundle::identity(&path)?.version != record.version {
        return Err("Installed application identity does not match the active slot".into());
    }
    Ok(path)
}

pub fn active_slot(root: &Path) -> Result<(Active, PathBuf)> {
    let record = active_record(root)?;
    let path = slot_path(root, &record)?;
    Ok((record, path))
}

/// Caller holds installation.lock for the entire compare and publish operation.
pub(crate) fn replace_active(root: &Path, expected: &Active, next: &Active) -> Result<()> {
    next.check()?;
    if active_record(root)? != *expected {
        return Err("The active installation changed during the update".into());
    }
    replace_record(root, ACTIVE, &canonical(next)?)
}

pub(crate) fn replace_record(root: &Path, name: &str, data: &[u8]) -> Result<()> {
    let root = fs::canonicalize(root)?;
    let temporary = root.join(format!("record-{}.part", Uuid::new_v4()));
    let result = (|| {
        write_new(&temporary, data)?;
        rename_record(&temporary, &root.join(name))?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(windows)]
fn rename_record(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<_> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Both strings are NUL-terminated paths in the same installation directory.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn rename_record(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

pub(crate) fn verified_active(root: &Path) -> Result<(Active, PathBuf, crate::manifest::Trust)> {
    let record = active_record(root)?;
    let (path, trust) = verified_slot(root, &record)?;
    Ok((record, path, trust))
}

pub(crate) fn verified_slot(
    root: &Path,
    record: &Active,
) -> Result<(PathBuf, crate::manifest::Trust)> {
    let path = slot_path(root, record)?;
    let trust = crate::embedded_trust()?;
    let trust = match fs::symlink_metadata(path.join(SLOT_TRANSITION)) {
        Ok(_) => trust.with_transition(
            &read_bounded(&path.join(SLOT_TRANSITION), METADATA_LIMIT)?,
            &read_bounded(&path.join(SLOT_TRANSITION_SIG), 64)?,
        )?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => trust,
        Err(error) => return Err(error.into()),
    };
    let verified = trust.read_release(
        &path.join(".forge-install-manifest.json"),
        &path.join(".forge-install-manifest.sig"),
    )?;
    if verified.data().version != record.version
        || verified.data().artifact.sha256 != record.package_sha256
    {
        return Err("The slot does not match its signed release record".into());
    }
    verified.ensure_compatible(HELPER_VERSION, PROJECT_SCHEMA, windows_build()?)?;
    Ok((path, trust))
}

pub(crate) fn desktop_command(root: &Path, path: &Path) -> Command {
    let mut command = Command::new(path.join("Forge.exe"));
    command
        .current_dir(path)
        .env("FORGE_INSTALLATION_ROOT", root)
        .env_remove("FORGE_STARTUP_CHECK")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

pub(crate) fn launch_active(root: &Path) -> Result<()> {
    let (_, path, _) = verified_active(root)?;
    // Keep the executable open on Windows with write and delete sharing disabled until it starts.
    let _executable = open_regular(&path.join("Forge.exe"))?;
    desktop_command(root, &path).spawn()?;
    Ok(())
}

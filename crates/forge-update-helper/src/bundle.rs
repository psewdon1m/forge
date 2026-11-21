use std::{
    collections::{HashMap, hash_map::Entry},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    Result, directory,
    manifest::{PLATFORM, PRODUCT, VerifiedManifest, lower_hex, stable_version},
    open_regular, read_bounded,
};

const MAX_FILES: usize = 2_048;
const UNPACK_LIMIT: u64 = 768 * 1024 * 1024;
const IDENTITY: &str = "forge-package.json";
const APP_ENTRY: &str = "resources/app/package.json";
const REQUIRED: [&str; 9] = [
    IDENTITY,
    "Forge.exe",
    "forge-update-helper.exe",
    "version",
    "LICENSE",
    "LICENSES.chromium.html",
    APP_ENTRY,
    "resources/app/apps/desktop/main.mjs",
    "resources/bin/forge-core.exe",
];

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageIdentity {
    pub product: String,
    pub platform: String,
    pub version: String,
    pub commit_sha: String,
    pub electron_version: String,
}

#[derive(Deserialize)]
struct AppPackage {
    name: String,
    main: String,
    version: String,
}

#[derive(Default)]
struct Names(HashMap<String, (String, bool)>);

impl Names {
    fn register(&mut self, name: &str) -> Result<()> {
        let mut full = String::new();
        let components = name.split('/');
        let count = components.clone().count();
        if name.len() > 220 || count > 12 {
            return Err("Package path is too long".into());
        }
        for (index, component) in components.enumerate() {
            if !valid_component(component) {
                return Err("Invalid Windows path in release ZIP".into());
            }
            if !full.is_empty() {
                full.push('/');
            }
            full.push_str(component);
            let file = index + 1 == count;
            match self.0.entry(full.to_ascii_lowercase()) {
                Entry::Vacant(entry) => {
                    entry.insert((full.clone(), file));
                }
                Entry::Occupied(entry) if !file && !entry.get().1 && entry.get().0 == full => {}
                Entry::Occupied(_) => {
                    return Err("Duplicate path or case collision in release ZIP".into());
                }
            }
        }
        Ok(())
    }

    fn check_required(&self) -> Result<()> {
        for name in REQUIRED {
            if !self
                .0
                .get(&name.to_ascii_lowercase())
                .is_some_and(|(stored, file)| stored == name && *file)
            {
                return Err(format!("Package is missing {name}").into());
            }
        }
        Ok(())
    }
}

fn valid_component(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 120
        || value.starts_with([' ', '.'])
        || value.ends_with([' ', '.'])
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ._-".contains(&byte))
    {
        return false;
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return false;
    }
    !matches!(
        stem.as_bytes(),
        [b'C', b'O', b'M', b'0'..=b'9'] | [b'L', b'P', b'T', b'0'..=b'9']
    )
}

fn document<T: serde::de::DeserializeOwned>(root: &Path, name: &str) -> Result<T> {
    Ok(serde_json::from_slice(&read_bounded(
        &root.join(name),
        16 * 1024,
    )?)?)
}

pub fn identity(root: &Path) -> Result<PackageIdentity> {
    let record: PackageIdentity = document(root, IDENTITY)?;
    let app: AppPackage = document(root, APP_ENTRY)?;
    stable_version(&record.version)?;
    stable_version(&record.electron_version)?;
    if record.product != PRODUCT
        || record.platform != PLATFORM
        || !lower_hex(&record.commit_sha, 40)
        || app.name != "forge-desktop"
        || app.main != "apps/desktop/main.mjs"
        || app.version != record.version
        || std::str::from_utf8(&read_bounded(&root.join("version"), 32)?)?.trim()
            != record.electron_version
    {
        return Err("Application and release package identities do not match".into());
    }
    for binary in [
        "Forge.exe",
        "forge-update-helper.exe",
        "resources/bin/forge-core.exe",
    ] {
        check_x64_pe(&root.join(binary))?;
    }
    Ok(record)
}

fn check_x64_pe(path: &Path) -> Result<()> {
    let mut file = open_regular(path)?;
    let mut header = [0; 64];
    file.read_exact(&mut header)?;
    let offset = u32::from_le_bytes(header[60..64].try_into()?) as u64;
    if &header[..2] != b"MZ" || !(64..=1024 * 1024).contains(&offset) {
        return Err("Package executable is not a Windows PE image".into());
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut pe = [0; 26];
    file.read_exact(&mut pe)?;
    if &pe[..4] != b"PE\0\0" || pe[4..6] != [0x64, 0x86] || pe[24..26] != [0x0b, 0x02] {
        return Err("Package executable is not Windows x64".into());
    }
    Ok(())
}

pub fn verified_file(path: &Path, manifest: &VerifiedManifest) -> Result<File> {
    let mut file = open_regular(path)?;
    let expected = &manifest.data().artifact;
    if file.metadata()?.len() != expected.bytes {
        return Err("Release package size does not match the signed size".into());
    }
    let mut hash = Sha256::new();
    let actual = io::copy(&mut (&mut file).take(expected.bytes + 1), &mut hash)?;
    if actual != expected.bytes || format!("{:x}", hash.finalize()) != expected.sha256 {
        return Err("Release package SHA-256 does not match the signed digest".into());
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

pub fn extract(file: File, staging: &Path, manifest: &VerifiedManifest) -> Result<PackageIdentity> {
    directory(staging)?;
    if fs::read_dir(staging)?.next().is_some() {
        return Err("Release staging directory must be empty".into());
    }
    let mut archive = ZipArchive::new(file)?;
    if archive.is_empty() || archive.len() > MAX_FILES {
        return Err("Unexpected number of entries in release ZIP".into());
    }
    let mut names = Names::default();
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if !entry.is_file()
            || entry.encrypted()
            || entry
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000))
            || !matches!(
                entry.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
        {
            return Err("Release ZIP entries must be ordinary unencrypted files".into());
        }
        names.register(&entry.name()?)?;
        expanded = expanded
            .checked_add(entry.size())
            .ok_or("Package expansion exceeded the limit")?;
        if expanded > UNPACK_LIMIT {
            return Err("Package expansion exceeded the limit".into());
        }
    }
    names.check_required()?;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let target = staging.join(entry.name()?.as_ref());
        fs::create_dir_all(target.parent().ok_or("Invalid package target")?)?;
        let size = entry.size();
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)?;
        if io::copy(&mut entry.take(size + 1), &mut output)? != size {
            return Err("Extracted entry size does not match the package".into());
        }
        output.sync_all()?;
    }
    let record = identity(staging)?;
    let expected = manifest.data();
    if record.version != expected.version || record.commit_sha != expected.commit_sha {
        return Err("Package embedded version or commit does not match the manifest".into());
    }
    Ok(record)
}

pub fn pack(root: &Path, destination: &Path) -> Result<()> {
    directory(root)?;
    identity(root)?;
    let mut files = Vec::new();
    collect(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut names = Names::default();
    for (name, _) in &files {
        names.register(name)?;
    }
    names.check_required()?;
    let staging = destination.with_extension(format!("{}.part", Uuid::new_v4()));
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(&staging)?;
    let result = (|| {
        let mut archive = ZipWriter::new(output);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default())
            .unix_permissions(0o644);
        for (name, file) in files {
            archive.start_file(name, options)?;
            io::copy(&mut open_regular(&file)?, &mut archive)?;
        }
        archive.finish()?.sync_all()?;
        fs::hard_link(&staging, destination)?;
        Ok(())
    })();
    let _ = fs::remove_file(staging);
    result
}

fn collect(root: &Path, folder: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            directory(&path)?;
            collect(root, &path, files)?;
        } else {
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .ok_or("Package filenames must be UTF-8")?
                .replace('\\', "/");
            files.push((relative, path));
            if files.len() > MAX_FILES {
                return Err("Too many package files".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Names;

    #[test]
    fn refuses_windows_path_aliases_and_conflicts() {
        for invalid in [
            "../forge.exe",
            "resources/../../forge.exe",
            "/forge.exe",
            "C:/forge.exe",
            "resources/app\\forge.exe",
            "resources/app/COM1.txt",
            "some/NUL.bin",
            "some/second:stream",
            "some/name. ",
            "some//file",
            "Café.zip",
        ] {
            assert!(Names::default().register(invalid).is_err(), "{invalid}");
        }
        let mut names = Names::default();
        names.register("resources/app/main.mjs").unwrap();
        names.register("resources/app/package.json").unwrap();
        for conflict in [
            "resources/app/main.mjs",
            "resources/app/Main.mjs",
            "Resources/app/readme.md",
            "resources/app",
            "resources/app/main.mjs/child",
        ] {
            assert!(names.register(conflict).is_err(), "{conflict}");
        }
    }
}

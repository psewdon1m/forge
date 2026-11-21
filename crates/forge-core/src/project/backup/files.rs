use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{File as SafeFile, OpenOptions as SafeOptions};

use super::*;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Inventory {
    pub files: Vec<FileMember>,
    pub directories: Vec<String>,
    pub excluded: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct FileMember {
    pub path: String,
    pub bytes: u64,
    pub fingerprint: String,
}

pub(super) fn valid_relative(value: &str) -> bool {
    if value.is_empty() || value.len() > 8192 || value.split('/').count() > 33 {
        return false;
    }
    value.split('/').all(|part| {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        !part.trim().is_empty()
            && !part.ends_with(['.', ' '])
            && part.encode_utf16().count() <= 240
            && !part.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
            && !part.chars().any(char::is_control)
            && !reserved
    })
}

pub(super) fn excluded_component(value: &str) -> bool {
    let name = value.to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".forge"
            | ".git"
            | ".ssh"
            | ".aws"
            | ".gnupg"
            | ".cache"
            | "node_modules"
            | "__pycache__"
            | "id_rsa"
            | "id_ed25519"
            | ".env"
    ) || name.starts_with(".env.")
        || name.starts_with(".forge-backup-")
        || [".key", ".pem", ".pfx", ".p12"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

pub(super) fn working_path(value: &str) -> bool {
    valid_relative(value)
        && !value.split('/').any(excluded_component)
        && !value
            .split('/')
            .next()
            .is_some_and(|part| part.eq_ignore_ascii_case("assets"))
}

pub(super) fn open_regular(dir: &Dir, name: &str) -> Result<SafeFile> {
    let mut options = SafeOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    let file = dir.open_with(name, &options)?;
    fingerprint(&file)?;
    Ok(file)
}

pub(super) fn fingerprint(file: &SafeFile) -> Result<(u64, String)> {
    #[cfg(windows)]
    {
        crate::directory::fingerprint_regular(file)
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(boundary(
                "Linked and special files are outside backup scope",
            ));
        }
        Ok((
            meta.len(),
            format!(
                "{}:{}:{}:{}:{}:{}",
                meta.dev(),
                meta.ino(),
                meta.mtime(),
                meta.mtime_nsec(),
                meta.ctime(),
                meta.ctime_nsec()
            ),
        ))
    }
}

pub(super) fn inventory(root: &Dir, assets: &[AssetRef]) -> Result<Inventory> {
    let mut output = Inventory {
        files: vec![],
        directories: vec![],
        excluded: 0,
    };
    let mut names = std::collections::HashSet::new();
    collect(root, "", 0, &mut output, &mut names)?;
    if !assets.is_empty() {
        let dir = root.open_dir_nofollow("assets")?;
        for asset in assets {
            let name = blob_name(asset);
            let file = open_regular(&dir, &name)?;
            let (bytes, finger) = fingerprint(&file)?;
            if bytes != asset.bytes {
                return Err(Error::AssetIntegrity);
            }
            output.files.push(FileMember {
                path: format!("assets/{name}"),
                bytes,
                fingerprint: finger,
            });
        }
    }
    output.files.sort_by(|a, b| a.path.cmp(&b.path));
    output.directories.sort();
    if output.files.len() + output.directories.len() + FIXED_MEMBERS > MAX_MEMBERS {
        return Err(archive_limit("Project tree exceeds the backup entry limit"));
    }
    Ok(output)
}

fn collect(
    dir: &Dir,
    prefix: &str,
    depth: usize,
    output: &mut Inventory,
    names: &mut std::collections::HashSet<String>,
) -> Result<()> {
    if depth > 32 {
        return Err(archive_limit("Project tree exceeds the backup depth limit"));
    }
    for entry in dir.entries()? {
        let name = entry?
            .file_name()
            .into_string()
            .map_err(|_| boundary("A project filename cannot be represented as UTF-8"))?;
        if prefix.is_empty() && name.eq_ignore_ascii_case("assets") {
            continue;
        }
        if excluded_component(&name) {
            output.excluded += 1;
            continue;
        }
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if !working_path(&path) || !names.insert(path.to_uppercase()) {
            return Err(boundary(
                "Project tree contains an unsafe or duplicate path",
            ));
        }
        if names.len() + FIXED_MEMBERS > MAX_MEMBERS {
            return Err(archive_limit("Project tree exceeds the backup entry limit"));
        }
        let meta = dir.symlink_metadata(&name)?;
        #[cfg(windows)]
        {
            use cap_std::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(boundary("Project tree contains a reparse point"));
            }
        }
        if meta.is_dir() {
            output.directories.push(path.clone());
            collect(
                &dir.open_dir_nofollow(&name)?,
                &path,
                depth + 1,
                output,
                names,
            )?;
        } else if meta.is_file() {
            let (bytes, finger) = fingerprint(&open_regular(dir, &name)?)?;
            output.files.push(FileMember {
                path,
                bytes,
                fingerprint: finger,
            });
        } else {
            return Err(boundary("Project tree contains a linked or special file"));
        }
    }
    Ok(())
}

pub(super) fn read_member(root: &Dir, entry: &FileMember, output: &mut impl Write) -> Result<()> {
    let (name, parents) = entry
        .path
        .rsplit_once('/')
        .map_or((entry.path.as_str(), ""), |(path, name)| (name, path));
    let mut held = vec![root.try_clone()?];
    for part in parents.split('/').filter(|part| !part.is_empty()) {
        held.push(held.last().expect("root").open_dir_nofollow(part)?);
    }
    let mut file = open_regular(held.last().expect("root"), name)?;
    let original = (entry.bytes, entry.fingerprint.clone());
    if fingerprint(&file)? != original {
        return Err(workspace_changed());
    }
    let bytes = io::copy(&mut (&mut file).take(entry.bytes + 1), output)?;
    if bytes != entry.bytes || fingerprint(&file)? != original {
        return Err(workspace_changed());
    }
    Ok(())
}

pub(super) fn blob_name(asset: &AssetRef) -> String {
    format!("asset-{}.{}", asset.version_id, asset.format.suffix())
}

pub(super) fn absolute_destination(destination: &Path) -> Result<PathBuf> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| valid_relative(name) && !name.contains('/'))
        .ok_or_else(|| boundary("Choose a valid destination name"))?;
    if !destination.is_absolute() {
        return Err(boundary("Choose an absolute destination"));
    }
    Ok(fs::canonicalize(
        destination
            .parent()
            .ok_or_else(|| boundary("Choose a destination folder"))?,
    )?
    .join(name))
}

pub(super) fn open_archive(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(boundary("Choose an absolute archive path"));
    }
    let parent = fs::canonicalize(
        path.parent()
            .ok_or_else(|| boundary("Choose an archive file"))?,
    )?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| boundary("Choose an archive file"))?;
    Ok(open_regular(&Dir::open_ambient_dir(parent, ambient_authority())?, name)?.into_std())
}

pub(super) struct Scratch(Option<PathBuf>);

impl Scratch {
    pub fn create(parent: &Path) -> Result<Self> {
        let path = parent.join(format!(".forge-backup-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self(Some(path)))
    }
    pub fn path(&self) -> &Path {
        self.0.as_deref().expect("temporary directory")
    }
    pub fn release(mut self) {
        self.0 = None;
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(path) = self.0.take()
            && fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir() && !is_link(&meta))
        {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub(super) use crate::storage::rename_exclusive as publish;

pub(super) fn ensure_space(path: &Path, needed: u64) -> Result<()> {
    let available = crate::storage::available_bytes(path)?;
    if available < needed {
        return Err(Error::Link(
            "STORAGE_FULL",
            "The destination volume has insufficient free space for this backup operation",
        ));
    }
    Ok(())
}

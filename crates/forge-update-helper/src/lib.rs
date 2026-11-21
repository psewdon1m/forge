pub mod bundle;
pub mod discovery;
pub mod install;
pub mod job;
pub mod manifest;
mod startup;

use std::{
    error::Error,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::Path,
};

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_regular(path)?
        .take((max + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err("Release metadata exceeds its size limit".into());
    }
    Ok(bytes)
}

fn reparse_point(info: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        info.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    info.file_type().is_symlink()
}

pub fn directory(path: &Path) -> Result<()> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_dir() || reparse_point(&info) {
        return Err("Expected a regular directory".into());
    }
    Ok(())
}

pub fn open_regular(path: &Path) -> Result<File> {
    open_with_sharing(path, false)
}

fn open_with_sharing(path: &Path, _allow_replace: bool) -> Result<File> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || reparse_point(&info) {
        return Err("Expected a regular file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ | if _allow_replace { FILE_SHARE_DELETE } else { 0 })
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let info = file.metadata()?;
    if !info.is_file() || reparse_point(&info) {
        return Err("Expected a regular file".into());
    }
    Ok(file)
}

pub fn embedded_trust() -> Result<manifest::Trust> {
    let key = option_env!("FORGE_RELEASE_PUBLIC_KEY_HEX")
        .ok_or("This executable has no embedded release trust anchor")?;
    manifest::Trust::new(key)
}

pub fn write_new(path: &Path, data: &[u8]) -> io::Result<()> {
    use io::Write;
    let mut output = OpenOptions::new().create_new(true).write(true).open(path)?;
    output.write_all(data)?;
    output.sync_all()
}

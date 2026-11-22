use std::{
    io::{self, Write},
    mem::{offset_of, size_of, size_of_val},
    os::windows::io::AsRawHandle,
    ptr::copy_nonoverlapping,
};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions, OpenOptionsExt};
use sha2::{Digest, Sha256};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, HANDLE},
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_BASIC_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileBasicInfo,
        FileDispositionInfo, FileRenameInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx, GetFinalPathNameByHandleW, SetFileInformationByHandle,
    },
    System::{
        IO::DeviceIoControl,
        Ioctl::{FSCTL_READ_FILE_USN_DATA, READ_FILE_USN_DATA, USN_RECORD_V2, USN_RECORD_V3},
    },
};

use super::{
    DirectoryChange, DirectoryEntry, DirectoryFile, DirectoryListing, EntryKind, VersionBasis,
};
use crate::{Error, Result};

const MAX_COMPONENT: usize = 240;
const MAX_DEPTH: usize = 32;
const MAX_ENTRIES: usize = 2_000;
const SHARE_STABLE_NAME: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;

fn operation_error(message: &'static str, error: io::Error) -> Error {
    match error.kind() {
        io::ErrorKind::AlreadyExists => {
            Error::Invalid("A file or folder with that name already exists")
        }
        io::ErrorKind::NotFound => Error::DirectoryChanged,
        _ if error.raw_os_error() == Some(145) => {
            Error::Invalid("Delete a folder only after it is empty")
        }
        _ => Error::DirectoryIo(message, error.raw_os_error().unwrap_or_default()),
    }
}

fn reserved_root(value: &str) -> bool {
    [".forge", "assets"]
        .iter()
        .any(|name| value.eq_ignore_ascii_case(name))
}

fn component(value: &str, at_root: bool) -> Result<()> {
    let base = value
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved = matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        base.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if value.trim().is_empty()
        || value.encode_utf16().count() > MAX_COMPONENT
        || value.ends_with(['.', ' '])
        || value.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
        || value.chars().any(char::is_control)
        || reserved
        || at_root && reserved_root(value)
    {
        return Err(Error::Invalid(
            "This name is outside the writable project tree",
        ));
    }
    Ok(())
}

struct Folder(Vec<Dir>);

impl Folder {
    fn open(root: &Dir, components: &[String]) -> Result<Self> {
        if components.len() > MAX_DEPTH {
            return Err(Error::Invalid(
                "Directory nesting exceeds the supported depth",
            ));
        }
        // The project root was opened by cap-std without FILE_SHARE_DELETE.
        let root = root.try_clone()?;
        if inspect(root.as_raw_handle())?.kind != EntryKind::Folder {
            return Err(Error::Invalid("Project root is not a regular directory"));
        }
        let mut folder = Self(vec![root]);
        for (depth, name) in components.iter().enumerate() {
            component(name, depth == 0)?;
            let child = open_entry(folder.current(), name, GENERIC_READ, SHARE_STABLE_NAME)?;
            if depth == 0 {
                check_root_entry(child.as_raw_handle())?;
            }
            if inspect(child.as_raw_handle())?.kind != EntryKind::Folder {
                return Err(Error::Invalid("Choose a regular project folder"));
            }
            folder.0.push(Dir::from_std_file(child.into_std()));
        }
        Ok(folder)
    }

    fn current(&self) -> &Dir {
        self.0.last().expect("the root handle is pinned")
    }
}

fn open_entry(parent: &Dir, name: &str, access: u32, sharing: u32) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    options
        .access_mode(access)
        .share_mode(sharing)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    parent
        .open_with(name, &options)
        .map_err(|error| operation_error("Could not open the project entry", error))
}

fn final_path(handle: HANDLE) -> Result<Vec<u16>> {
    let mut name = vec![0u16; 512];
    loop {
        let length =
            unsafe { GetFinalPathNameByHandleW(handle, name.as_mut_ptr(), name.len() as u32, 0) }
                as usize;
        if length == 0 {
            return Err(io::Error::last_os_error().into());
        }
        if length >= name.len() {
            if length >= 32_768 {
                return Err(Error::Invalid(
                    "Project entry path exceeds the supported length",
                ));
            }
            name.resize(length + 1, 0);
            continue;
        }
        name.truncate(length);
        return Ok(name);
    }
}

fn check_root_entry(handle: HANDLE) -> Result<()> {
    // The normalized name also detects DOS aliases of a protected entry.
    let name = final_path(handle)?;
    let leaf = name
        .rsplit(|code| *code == b'\\' as u16)
        .next()
        .unwrap_or_default();
    if reserved_root(&String::from_utf16_lossy(leaf)) {
        return Err(Error::Invalid(
            "Forge storage is outside the writable project tree",
        ));
    }
    Ok(())
}
struct Metadata {
    kind: EntryKind,
    bytes: u64,
    version: String,
}

fn inspect(handle: HANDLE) -> Result<Metadata> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let mut times = FILE_BASIC_INFO::default();
    // Both outputs have their exact Win32 layout and remain live for the two calls.
    if unsafe {
        GetFileInformationByHandle(handle, &mut info) == 0
            || GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&raw mut times).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            ) == 0
    } {
        return Err(io::Error::last_os_error().into());
    }
    let directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(Error::Invalid(
            "Linked entries are unavailable in Directory",
        ));
    }
    let bytes = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
    let mut fingerprint = Sha256::new();
    for value in [
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
        info.dwFileAttributes,
    ] {
        fingerprint.update(value.to_le_bytes());
    }
    for time in [times.CreationTime, times.LastWriteTime, times.ChangeTime] {
        fingerprint.update(time.to_le_bytes());
    }
    fingerprint.update(bytes.to_le_bytes());
    Ok(Metadata {
        kind: if directory {
            EntryKind::Folder
        } else {
            EntryKind::File
        },
        bytes,
        version: format!("{:x}", fingerprint.finalize()),
    })
}

pub(super) fn fingerprint_regular(file: &File) -> Result<(u64, String)> {
    let info = inspect(file.as_raw_handle())?;
    if info.kind != EntryKind::File {
        return Err(Error::Invalid("Choose a regular file"));
    }
    Ok((info.bytes, info.version))
}

fn change_sequence(handle: HANDLE) -> Option<i64> {
    let version = READ_FILE_USN_DATA {
        MinMajorVersion: 2,
        MaxMajorVersion: 3,
    };
    let mut record = [0u8; 1024];
    let mut length = 0;
    // A synchronous control call reads the last journal sequence for this open entry.
    if unsafe {
        DeviceIoControl(
            handle,
            FSCTL_READ_FILE_USN_DATA,
            (&raw const version).cast(),
            size_of::<READ_FILE_USN_DATA>() as u32,
            record.as_mut_ptr().cast(),
            record.len() as u32,
            &mut length,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return None;
    }
    let record = record.get(..length as usize)?;
    let offset = match u16::from_le_bytes(record.get(4..6)?.try_into().ok()?) {
        2 => offset_of!(USN_RECORD_V2, Usn),
        3 => offset_of!(USN_RECORD_V3, Usn),
        _ => return None,
    };
    let sequence = i64::from_le_bytes(record.get(offset..offset + 8)?.try_into().ok()?);
    (sequence > 0).then_some(sequence)
}

fn mutation_metadata(parent: &Dir, name: &str, file: &File) -> Result<Metadata> {
    let mut meta = inspect(file.as_raw_handle())?;
    if meta.kind != EntryKind::File {
        return Ok(meta);
    }
    let mut fingerprint = Sha256::new();
    if let Some(sequence) = change_sequence(file.as_raw_handle()) {
        fingerprint.update(b"forge.directory.mutation.usn.v1");
        fingerprint.update(sequence.to_le_bytes());
    } else {
        // The first handle pins the name. A second handle denies writers during the read
        // and shares DELETE so it can coexist with our own mutation handle.
        let mut reader = open_entry(
            parent,
            name,
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
        )?;
        meta = inspect(reader.as_raw_handle())?;
        fingerprint.update(b"forge.directory.mutation.content.v1");
        if io::copy(&mut reader, &mut fingerprint)? != meta.bytes {
            return Err(Error::DirectoryChanged);
        }
    }
    fingerprint.update(meta.version.as_bytes());
    meta.version = format!("{:x}", fingerprint.finalize());
    Ok(meta)
}

pub(super) fn list(
    root: &Dir,
    components: &[String],
    basis: VersionBasis,
) -> Result<DirectoryListing> {
    let folder = Folder::open(root, components)?;
    let current = folder.current();
    let mut entries = Vec::new();
    for entry in current.entries()? {
        let raw_name = entry?.file_name();
        let name = raw_name.to_string_lossy().into_owned();
        if components.is_empty() && reserved_root(&name) {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            return Err(Error::Invalid(
                "This folder exceeds the Directory listing limit",
            ));
        }
        let metadata = raw_name
            .to_str()
            .ok_or(Error::Invalid("Unsupported filename encoding"))
            .and_then(|name| component(name, components.is_empty()))
            .and_then(|()| {
                let file = open_entry(current, &name, FILE_READ_ATTRIBUTES, SHARE_STABLE_NAME)?;
                match basis {
                    VersionBasis::Metadata => inspect(file.as_raw_handle()),
                    VersionBasis::Mutation => mutation_metadata(current, &name, &file),
                }
            });
        entries.push(match metadata {
            Ok(meta) => DirectoryEntry {
                name,
                kind: meta.kind,
                bytes: (meta.kind == EntryKind::File).then_some(meta.bytes),
                version: Some(meta.version),
            },
            Err(_) => DirectoryEntry {
                name,
                kind: EntryKind::Unavailable,
                bytes: None,
                version: None,
            },
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != EntryKind::Folder, a.name.to_lowercase())
            .cmp(&(b.kind != EntryKind::Folder, b.name.to_lowercase()))
    });
    Ok(DirectoryListing {
        folder_version: inspect(current.as_raw_handle())?.version,
        entries,
    })
}

fn check_version(meta: &Metadata, expected: &str) -> Result<()> {
    if meta.version != expected {
        return Err(Error::DirectoryChanged);
    }
    Ok(())
}

pub(super) fn read_file(
    root: &Dir,
    expected: &DirectoryFile,
    limit: u64,
    output: &mut impl Write,
    mut checkpoint: impl FnMut() -> Result<()>,
) -> Result<String> {
    let changed = || {
        Error::Link(
            "SOURCE_CHANGED",
            "The Directory file changed. Check the source and choose it again.",
        )
    };
    let (name, parents) = expected.relative_path.split_last().ok_or_else(changed)?;
    checkpoint()?;
    let folder = Folder::open(root, parents).map_err(|_| changed())?;
    component(name, parents.is_empty()).map_err(|_| changed())?;
    // Deny writers and deletion during the read. Every ancestor stays pinned by Folder.
    let mut file =
        open_entry(folder.current(), name, GENERIC_READ, FILE_SHARE_READ).map_err(|_| changed())?;
    if parents.is_empty() {
        check_root_entry(file.as_raw_handle()).map_err(|_| changed())?;
    }
    let inspect_file = |file: &File| {
        let live = inspect(file.as_raw_handle()).map_err(|_| changed())?;
        if live.kind != EntryKind::File
            || live.version != expected.fingerprint
            || live.bytes != expected.bytes
        {
            return Err(changed());
        }
        Ok(())
    };
    inspect_file(&file)?;
    if expected.bytes > limit || expected.bytes > crate::assets::MAX_FILE_BYTES {
        return Err(Error::Link(
            "LIMIT_EXCEEDED",
            "The Directory file exceeds the reading limit",
        ));
    }
    let mut remaining = expected.bytes;
    let (bytes, sha) =
        crate::assets::copy_and_hash_progress(&mut file, output, &mut remaining, |_| checkpoint())?;
    inspect_file(&file)?;
    if bytes != expected.bytes
        || expected
            .sha256
            .as_ref()
            .is_some_and(|previous| previous != &sha)
    {
        return Err(changed());
    }
    Ok(sha)
}

fn mutation_source(folder: &Dir, name: &str, version: &str, at_root: bool) -> Result<File> {
    component(name, at_root)?;
    let file = open_entry(folder, name, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ)?;
    if at_root {
        check_root_entry(file.as_raw_handle())?;
    }
    check_version(&mutation_metadata(folder, name, &file)?, version)?;
    Ok(file)
}

fn rename(source: &File, destination: &Dir, name: &str) -> Result<()> {
    let mut target = final_path(destination.as_raw_handle())?;
    target.push(b'\\' as u16);
    target.extend(name.encode_utf16());
    let prefix = offset_of!(FILE_RENAME_INFO, FileName);
    let length = prefix + size_of_val(target.as_slice()) + size_of::<u16>();
    let mut bytes = vec![0u64; length.div_ceil(size_of::<u64>())];
    let info = bytes.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // The destination path comes from the pinned folder, with one checked leaf appended.
    // The zero-initialized buffer supplies the required alignment, terminator and no-replace flag.
    if unsafe {
        (*info).FileNameLength = size_of_val(target.as_slice()) as u32;
        copy_nonoverlapping(
            target.as_ptr(),
            bytes.as_mut_ptr().cast::<u8>().add(prefix).cast(),
            target.len(),
        );
        SetFileInformationByHandle(
            source.as_raw_handle(),
            FileRenameInfo,
            info.cast(),
            length as u32,
        ) == 0
    } {
        return Err(operation_error(
            "Could not rename or move the project entry",
            io::Error::last_os_error(),
        ));
    }
    Ok(())
}

pub(super) fn change(root: &Dir, action: DirectoryChange) -> Result<()> {
    match action {
        DirectoryChange::CreateFolder {
            parent,
            folder_version,
            name,
        } => {
            component(&name, parent.is_empty())?;
            if parent.len() >= MAX_DEPTH {
                return Err(Error::Invalid(
                    "Directory nesting exceeds the supported depth",
                ));
            }
            let folder = Folder::open(root, &parent)?;
            check_version(&inspect(folder.current().as_raw_handle())?, &folder_version)?;
            folder
                .current()
                .create_dir(name)
                .map_err(|error| operation_error("Could not create the project folder", error))?;
        }
        DirectoryChange::Rename {
            parent,
            name,
            version,
            new_name,
        } => {
            component(&new_name, parent.is_empty())?;
            let folder = Folder::open(root, &parent)?;
            let file = mutation_source(folder.current(), &name, &version, parent.is_empty())?;
            rename(&file, folder.current(), &new_name)?;
        }
        DirectoryChange::Move {
            parent,
            name,
            version,
            destination,
            destination_version,
        } => {
            component(&name, destination.is_empty())?;
            if parent == destination {
                return Err(Error::Invalid("Choose a different destination folder"));
            }
            let source = Folder::open(root, &parent)?;
            let target = Folder::open(root, &destination)?;
            check_version(
                &inspect(target.current().as_raw_handle())?,
                &destination_version,
            )?;
            let file = mutation_source(source.current(), &name, &version, parent.is_empty())?;
            rename(&file, target.current(), &name)?;
        }
        DirectoryChange::Delete {
            parent,
            name,
            version,
        } => {
            let folder = Folder::open(root, &parent)?;
            let file = mutation_source(folder.current(), &name, &version, parent.is_empty())?;
            let info = FILE_DISPOSITION_INFO { DeleteFile: true };
            // The kernel rejects nonempty directories and the deletion applies to this open entry.
            if unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfo,
                    (&raw const info).cast(),
                    size_of_val(&info) as u32,
                ) == 0
            } {
                return Err(operation_error(
                    "Could not delete the project entry",
                    io::Error::last_os_error(),
                ));
            }
        }
    }
    Ok(())
}

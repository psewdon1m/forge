use std::{io::Write, path::Path};

use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{AssetFormat, Error, Result};

pub const DIRECTORY_TYPE: &str = "forge.directory";
const MAX_COLLECTION_ENTRIES: usize = 5_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryFile {
    pub asset_id: Uuid,
    pub version_id: Uuid,
    pub name: String,
    pub relative_path: Vec<String>,
    pub fingerprint: String,
    pub bytes: u64,
    pub format: Option<AssetFormat>,
    pub sha256: Option<String>,
}

pub(crate) struct FileCollection {
    pub revision: String,
    pub files: Vec<DirectoryFile>,
    pub unavailable_count: usize,
}

pub(crate) fn file_collection(root: &Dir) -> Result<FileCollection> {
    let mut folders = vec![vec![]];
    let mut visited = 0;
    let mut files = Vec::new();
    let mut unavailable = Vec::new();
    while let Some(folder) = folders.pop() {
        for entry in list_entries(root, &folder, VersionBasis::Metadata)?.entries {
            visited += 1;
            if visited > MAX_COLLECTION_ENTRIES {
                return Err(Error::Invalid(
                    "Directory source supports up to 5000 entries",
                ));
            }
            let mut path = folder.clone();
            path.push(entry.name);
            match (entry.kind, entry.bytes, entry.version) {
                (EntryKind::Folder, _, _) => {
                    if path.len() <= 32 {
                        folders.push(path);
                    } else {
                        unavailable.push(path);
                    }
                }
                (EntryKind::File, Some(bytes), Some(fingerprint)) => {
                    let mut identity = Sha256::new();
                    identity.update(b"forge.directory.file.v1");
                    hash_path(&mut identity, &path);
                    let asset_id = hashed_id(identity);
                    let mut version = Sha256::new();
                    version.update(b"forge.directory.version.v1");
                    version.update(asset_id.as_bytes());
                    version.update(fingerprint.as_bytes());
                    let format =
                        AssetFormat::from_path(Path::new(path.last().expect("file path"))).ok();
                    files.push(DirectoryFile {
                        asset_id,
                        version_id: hashed_id(version),
                        name: path.join("/"),
                        relative_path: path,
                        bytes,
                        fingerprint,
                        format,
                        sha256: None,
                    });
                }
                _ => unavailable.push(path),
            }
        }
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    unavailable.sort();
    let mut revision = Sha256::new();
    revision.update(b"forge.directory.collection.v1");
    revision.update((files.len() as u64).to_le_bytes());
    for item in &files {
        revision.update(item.version_id.as_bytes());
    }
    for path in &unavailable {
        hash_path(&mut revision, path);
    }
    Ok(FileCollection {
        files,
        unavailable_count: unavailable.len(),
        revision: format!("{:x}", revision.finalize()),
    })
}

fn hash_path(hasher: &mut Sha256, path: &[String]) {
    hasher.update((path.len() as u64).to_le_bytes());
    for name in path {
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
    }
}

fn hashed_id(hasher: Sha256) -> Uuid {
    let digest = hasher.finalize();
    uuid::Builder::from_custom_bytes(digest[..16].try_into().expect("SHA-256 covers UUID"))
        .into_uuid()
}

pub(crate) fn read_file(
    root: &Dir,
    file: &DirectoryFile,
    limit: u64,
    output: &mut impl Write,
    checkpoint: impl FnMut() -> Result<()>,
) -> Result<String> {
    #[cfg(windows)]
    {
        windows::read_file(root, file, limit, output, checkpoint)
    }
    #[cfg(not(windows))]
    {
        let _ = (root, file, limit, output, checkpoint);
        Err(Error::Invalid("Project Directory requires Windows"))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub folder_version: String,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: EntryKind,
    pub bytes: Option<u64>,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Folder,
    Unavailable,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DirectoryChange {
    CreateFolder {
        parent: Vec<String>,
        folder_version: String,
        name: String,
    },
    Rename {
        parent: Vec<String>,
        name: String,
        version: String,
        new_name: String,
    },
    Move {
        parent: Vec<String>,
        name: String,
        version: String,
        destination: Vec<String>,
        destination_version: String,
    },
    Delete {
        parent: Vec<String>,
        name: String,
        version: String,
    },
}

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) fn fingerprint_regular(file: &cap_std::fs::File) -> Result<(u64, String)> {
    windows::fingerprint_regular(file)
}

#[derive(Clone, Copy)]
enum VersionBasis {
    Metadata,
    Mutation,
}

pub(crate) fn list(root: &Dir, folder: &[String]) -> Result<DirectoryListing> {
    list_entries(root, folder, VersionBasis::Mutation)
}

fn list_entries(root: &Dir, folder: &[String], basis: VersionBasis) -> Result<DirectoryListing> {
    #[cfg(windows)]
    {
        windows::list(root, folder, basis)
    }
    #[cfg(not(windows))]
    {
        let _ = (root, folder, basis);
        Err(crate::Error::Invalid("Project Directory requires Windows"))
    }
}

pub(crate) fn change(root: &Dir, action: DirectoryChange) -> Result<()> {
    #[cfg(windows)]
    {
        windows::change(root, action)
    }
    #[cfg(not(windows))]
    {
        let _ = (root, action);
        Err(crate::Error::Invalid("Project Directory requires Windows"))
    }
}

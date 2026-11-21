use std::{
    fs,
    path::{Path, PathBuf},
};

use git2::{
    BranchType, Config, Diff, DiffFormat, DiffOptions, ErrorCode, Repository, RepositoryOpenFlags,
    RepositoryState, Sort, Status, StatusOptions, Tree,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

mod mutation;
pub use mutation::{Action, mutate};

pub const TYPE_ID: &str = "forge.git";
const MAX_STATUS_ITEMS: usize = 5_000;
const MAX_BRANCHES: usize = 1_000;
const HISTORY_LIMIT: usize = 40;
const MAX_DIFF_FILE_BYTES: i64 = 1024 * 1024;
const MAX_DIFF_RESPONSE_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Document {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    repository_name: String,
    branch: Option<String>,
    head: Option<String>,
    branches: Vec<Branch>,
    history: Vec<Commit>,
    history_has_more: bool,
    entries: Vec<Entry>,
    conflicted: bool,
    operation_in_progress: bool,
    revision: String,
}

#[derive(Serialize)]
struct Branch {
    name: String,
    commit: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    id: String,
    subject: String,
    author: String,
    time_seconds: i64,
}

#[derive(Serialize)]
struct Entry {
    path: String,
    staged: Option<Change>,
    unstaged: Option<Change>,
    conflicted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum Change {
    Added,
    Modified,
    Deleted,
    TypeChanged,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    Staged,
    Unstaged,
}

#[derive(Serialize)]
pub struct Patch {
    text: String,
    truncated: bool,
}

pub fn inspect(root: &Path) -> Result<Snapshot> {
    let workspace = Workspace::open(root)?;
    workspace.snapshot()
}

pub fn diff(root: &Path, path: &str, side: DiffSide, revision: &str) -> Result<Patch> {
    let workspace = Workspace::open(root)?;
    let snapshot = workspace.snapshot()?;
    check_revision(&snapshot, revision)?;
    let entry = snapshot.entries.iter().find(|entry| entry.path == path);
    let present = entry.is_some_and(|entry| match side {
        DiffSide::Staged => entry.staged.is_some(),
        DiffSide::Unstaged => entry.unstaged.is_some(),
    });
    if !present {
        return Err(Error::Git(
            "GIT_PATH_CHANGED",
            "The selected Git change is no longer present",
        ));
    }

    let index = checked(workspace.repository.index())?;
    let mut options = diff_options();
    options
        .pathspec(path)
        .disable_pathspec_match(true)
        .include_untracked(true)
        .show_untracked_content(true);
    let diff = match side {
        DiffSide::Staged => {
            let head = workspace.head_tree()?;
            checked(workspace.repository.diff_tree_to_index(
                head.as_ref(),
                Some(&index),
                Some(&mut options),
            ))?
        }
        DiffSide::Unstaged => checked(
            workspace
                .repository
                .diff_index_to_workdir(Some(&index), Some(&mut options)),
        )?,
    };
    render_patch(&diff)
}

struct Workspace {
    root: PathBuf,
    repository: Repository,
}

impl Workspace {
    fn open(root: &Path) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(|_| invalid_repository())?;
        let admin = root.join(".git");
        if !is_plain_directory(&admin) {
            return Err(invalid_repository());
        }
        for redirect in [
            "commondir",
            "objects/info/alternates",
            "objects/info/http-alternates",
        ] {
            if admin.join(redirect).symlink_metadata().is_ok() {
                return Err(invalid_repository());
            }
        }
        validate_metadata_tree(&admin)?;
        let repository = Repository::open_ext(
            &root,
            RepositoryOpenFlags::NO_SEARCH,
            std::iter::empty::<&Path>(),
        )
        .map_err(|_| invalid_repository())?;
        if repository.is_bare()
            || repository.is_worktree()
            || repository
                .workdir()
                .and_then(|path| fs::canonicalize(path).ok())
                .as_ref()
                != Some(&root)
            || fs::canonicalize(repository.path()).ok().as_ref() != Some(&admin)
        {
            return Err(invalid_repository());
        }
        checked(repository.set_config(&checked(Config::new())?))?;
        Ok(Self { root, repository })
    }

    fn snapshot(&self) -> Result<Snapshot> {
        let head_ref = checked(self.repository.find_reference("HEAD"))?;
        let branch = checked(head_ref.symbolic_target())?
            .and_then(|reference| reference.strip_prefix("refs/heads/"))
            .map(str::to_owned);
        let head = self.head()?.map(|commit| commit.id());
        let mut branches = Vec::new();
        for branch in checked(self.repository.branches(Some(BranchType::Local)))? {
            if branches.len() == MAX_BRANCHES {
                return Err(Error::Git(
                    "GIT_LIMIT",
                    "Git supports up to 1000 local branches",
                ));
            }
            let (branch, _) = checked(branch)?;
            let name = checked(branch.name())?
                .ok_or_else(unsupported_path)?
                .to_owned();
            let commit = checked(branch.get().peel_to_commit())?.id().to_string();
            branches.push(Branch { name, commit });
        }
        branches.sort_by(|a, b| a.name.cmp(&b.name));

        let mut history = Vec::new();
        let mut history_has_more = false;
        if let Some(id) = head {
            let mut walk = checked(self.repository.revwalk())?;
            checked(walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME))?;
            checked(walk.push(id))?;
            for id in walk {
                if history.len() == HISTORY_LIMIT {
                    history_has_more = true;
                    break;
                }
                let commit = checked(self.repository.find_commit(checked(id)?))?;
                history.push(Commit {
                    id: commit.id().to_string(),
                    subject: commit
                        .summary()
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                        .chars()
                        .take(240)
                        .collect(),
                    author: commit
                        .author()
                        .name()
                        .unwrap_or_default()
                        .chars()
                        .take(120)
                        .collect(),
                    time_seconds: commit.time().seconds(),
                });
            }
        }

        let index = checked(self.repository.index())?;
        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .exclude_submodules(false);
        let status = checked(self.repository.statuses(Some(&mut options)))?;
        if status.len() > MAX_STATUS_ITEMS {
            return Err(Error::Git(
                "GIT_LIMIT",
                "Git supports up to 5000 pending paths",
            ));
        }
        let mut entries = Vec::with_capacity(status.len());
        let mut digest = Sha256::new();
        digest.update(b"forge.git.snapshot.v1\0");
        digest.update(index.len().to_le_bytes());
        for item in index.iter() {
            digest.update((item.path.len() as u64).to_le_bytes());
            digest.update(&item.path);
            digest.update(item.id.as_bytes());
            digest.update(item.mode.to_le_bytes());
            digest.update(item.flags.to_le_bytes());
            digest.update(item.flags_extended.to_le_bytes());
        }
        for entry in status.iter() {
            let path = entry.path().map_err(|_| unsupported_path())?;
            validate_relative_path(path)?;
            let flags = entry.status();
            digest.update((path.len() as u64).to_le_bytes());
            digest.update(path.as_bytes());
            digest.update(flags.bits().to_le_bytes());
            if let Some(fingerprint) = worktree_stamp(&self.root, path)? {
                digest.update(fingerprint);
            }
            entries.push(Entry {
                path: path.to_owned(),
                staged: change(
                    flags,
                    [
                        Status::INDEX_NEW,
                        Status::INDEX_MODIFIED,
                        Status::INDEX_DELETED,
                        Status::INDEX_TYPECHANGE,
                    ],
                ),
                unstaged: change(
                    flags,
                    [
                        Status::WT_NEW,
                        Status::WT_MODIFIED,
                        Status::WT_DELETED,
                        Status::WT_TYPECHANGE,
                    ],
                ),
                conflicted: flags.contains(Status::CONFLICTED),
            });
        }
        let conflicted = index.has_conflicts();
        let operation_in_progress = self.repository.state() != RepositoryState::Clean;
        let head = head.map(|id| id.to_string());
        digest.update(serde_json::to_vec(&(
            &branch,
            &head,
            &branches,
            conflicted,
            operation_in_progress,
        ))?);
        Ok(Snapshot {
            repository_name: self
                .root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Git repository")
                .to_owned(),
            branch,
            head,
            branches,
            history,
            history_has_more,
            entries,
            conflicted,
            operation_in_progress,
            revision: format!("{:x}", digest.finalize()),
        })
    }

    fn head(&self) -> Result<Option<git2::Commit<'_>>> {
        match self.repository.head() {
            Ok(reference) => Ok(Some(checked(reference.peel_to_commit())?)),
            Err(error) if error.code() == ErrorCode::UnbornBranch => Ok(None),
            Err(error) => checked(Err(error)),
        }
    }

    fn head_tree(&self) -> Result<Option<Tree<'_>>> {
        self.head()?
            .map(|commit| checked(commit.tree()))
            .transpose()
    }
}

fn diff_options() -> DiffOptions {
    let mut options = DiffOptions::new();
    options.context_lines(3).max_size(MAX_DIFF_FILE_BYTES);
    options
}

fn render_patch(diff: &Diff<'_>) -> Result<Patch> {
    let mut buffer = Vec::new();
    let mut truncated = false;
    let result = diff.print(DiffFormat::Patch, |_, _, line| {
        let content = line.content();
        if buffer.len() + content.len() + 1 > MAX_DIFF_RESPONSE_BYTES {
            truncated = true;
            return false;
        }
        if matches!(line.origin(), ' ' | '+' | '-') {
            buffer.push(line.origin() as u8);
        }
        buffer.extend_from_slice(content);
        true
    });
    if !truncated {
        checked(result)?;
    }
    Ok(Patch {
        text: String::from_utf8_lossy(&buffer).into_owned(),
        truncated,
    })
}

fn check_revision(snapshot: &Snapshot, revision: &str) -> Result<()> {
    if snapshot.revision == revision {
        Ok(())
    } else {
        Err(Error::Git(
            "GIT_CHANGED",
            "The Git working tree changed. Refresh and try again",
        ))
    }
}

fn change(flags: Status, [add, modify, delete, type_change]: [Status; 4]) -> Option<Change> {
    if flags.contains(add) {
        Some(Change::Added)
    } else if flags.contains(modify) {
        Some(Change::Modified)
    } else if flags.contains(delete) {
        Some(Change::Deleted)
    } else if flags.contains(type_change) {
        Some(Change::TypeChanged)
    } else {
        None
    }
}

fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 1024
        || path.contains(['\\', ':', '\0'])
        || path.split('/').any(|part| {
            part.is_empty() || matches!(part, "." | "..") || part.eq_ignore_ascii_case(".git")
        })
    {
        return Err(unsupported_path());
    }
    Ok(())
}

fn worktree_stamp(root: &Path, path: &str) -> Result<Option<[u8; 24]>> {
    let mut absolute = root.to_owned();
    for part in path.split('/') {
        absolute.push(part);
        let metadata = match absolute.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(Error::Git(
                    "GIT_IO",
                    "A changed Git path could not be inspected",
                ));
            }
        };
        if redirects(&metadata) {
            return Err(unsupported_path());
        }
    }
    let metadata = absolute.symlink_metadata().map_err(|_| {
        Error::Git(
            "GIT_CHANGED",
            "The Git working tree changed. Refresh and try again",
        )
    })?;
    let mut stamp = [0u8; 24];
    stamp[..8].copy_from_slice(&metadata.len().to_le_bytes());
    if let Ok(modified) = metadata.modified().and_then(|time| {
        time.duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)
    }) {
        stamp[8..].copy_from_slice(&modified.as_nanos().to_le_bytes());
    }
    Ok(Some(stamp))
}

fn validate_metadata_tree(directory: &Path) -> Result<()> {
    let mut pending = vec![directory.to_owned()];
    let mut checked_entries = 0;
    while let Some(folder) = pending.pop() {
        for item in fs::read_dir(folder).map_err(|_| invalid_repository())? {
            let item = item.map_err(|_| invalid_repository())?;
            let metadata = item
                .path()
                .symlink_metadata()
                .map_err(|_| invalid_repository())?;
            checked_entries += 1;
            if checked_entries > 100_000 {
                return Err(Error::Git(
                    "GIT_LIMIT",
                    "This repository has more than 100000 Git metadata entries",
                ));
            }
            if redirects(&metadata) || !(metadata.is_file() || metadata.is_dir()) {
                return Err(invalid_repository());
            }
            if metadata.is_dir() {
                pending.push(item.path());
            }
        }
    }
    Ok(())
}

fn is_plain_directory(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|metadata| metadata.is_dir() && !redirects(&metadata))
}

#[cfg(windows)]
fn redirects(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn redirects(metadata: &fs::Metadata) -> bool {
    metadata.is_symlink()
}

fn invalid_repository() -> Error {
    Error::Git(
        "GIT_REPOSITORY",
        "Choose the root of a local Git working tree with its own .git directory",
    )
}

fn unsupported_path() -> Error {
    Error::Git(
        "GIT_PATH",
        "This Git path is unsupported or redirects outside the working tree",
    )
}

fn checked<T>(result: std::result::Result<T, git2::Error>) -> Result<T> {
    result.map_err(|error| match error.code() {
        ErrorCode::Locked | ErrorCode::Modified => Error::Git(
            "GIT_CHANGED",
            "Another Git writer changed or locked the repository. Refresh and try again",
        ),
        ErrorCode::Conflict | ErrorCode::MergeConflict => Error::Git(
            "GIT_CONFLICT",
            "Resolve the Git conflict in your Git client and refresh",
        ),
        _ => Error::Git(
            "GIT_IO",
            "Git could not complete this operation. Refresh the repository and try again",
        ),
    })
}

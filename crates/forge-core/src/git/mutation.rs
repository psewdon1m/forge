use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use git2::{
    BranchType, Index, IndexEntry, IndexTime, Signature, TreeWalkMode, TreeWalkResult,
    build::CheckoutBuilder,
};
use serde::Deserialize;
use uuid::Uuid;

use super::{
    Change, Snapshot, Workspace, check_revision, checked, unsupported_path, validate_relative_path,
};
use crate::{Error, Result};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Stage {
        path: String,
    },
    Unstage {
        path: String,
    },
    Commit {
        author_name: String,
        author_email: String,
        message: String,
    },
    SwitchBranch {
        branch: String,
    },
}

pub fn mutate(root: &Path, revision: &str, action: Action) -> Result<Snapshot> {
    let workspace = Workspace::open(root)?;
    match action {
        Action::Stage { path } => update_index(&workspace, revision, &path, true)?,
        Action::Unstage { path } => update_index(&workspace, revision, &path, false)?,
        Action::Commit {
            author_name,
            author_email,
            message,
        } => commit(&workspace, revision, &author_name, &author_email, &message)?,
        Action::SwitchBranch { branch } => switch_branch(&workspace, revision, &branch)?,
    }
    Workspace::open(root)?.snapshot()
}

fn ready(workspace: &Workspace, revision: &str) -> Result<Snapshot> {
    let snapshot = workspace.snapshot()?;
    if snapshot.conflicted || snapshot.operation_in_progress {
        return Err(Error::Git(
            "GIT_CONFLICT",
            "Resolve the Git conflict or finish the active Git operation in your Git client",
        ));
    }
    check_revision(&snapshot, revision)?;
    Ok(snapshot)
}

fn update_index(workspace: &Workspace, revision: &str, path: &str, stage: bool) -> Result<()> {
    validate_relative_path(path)?;
    let admin = workspace.root.join(".git");
    let lock = IndexLock::acquire(&admin)?;
    let snapshot = ready(workspace, revision)?;
    let entry = snapshot.entries.iter().find(|entry| entry.path == path);
    let change = entry.and_then(|entry| {
        if stage {
            entry.unstaged.as_ref()
        } else {
            entry.staged.as_ref()
        }
    });
    let change = change.ok_or(Error::Git(
        "GIT_PATH_CHANGED",
        "The selected Git change is no longer present",
    ))?;
    let scratch = ScratchIndex::copy(&admin)?;
    let mut index = checked(Index::open(&scratch.path))?;
    checked(workspace.repository.set_index(&mut index))?;
    let relative = Path::new(path);
    if stage {
        if matches!(change, Change::Deleted) {
            checked(index.remove_path(relative))?;
        } else {
            let actual = workspace.root.join(relative);
            let metadata = actual.symlink_metadata().map_err(|_| unsupported_path())?;
            if !metadata.is_file() || super::redirects(&metadata) {
                return Err(unsupported_path());
            }
            checked(index.add_path(relative))?;
        }
    } else {
        restore_head_entry(workspace, &mut index, path)?;
    }

    checked(index.write())?;
    lock.publish(&scratch.path, &admin.join("index"))
}

fn restore_head_entry(workspace: &Workspace, index: &mut Index, path: &str) -> Result<()> {
    let relative = Path::new(path);
    let head = workspace.head_tree()?;
    let entry = match head
        .as_ref()
        .map(|tree| tree.get_path(relative))
        .transpose()
    {
        Ok(entry) => entry,
        Err(error) if error.code() == git2::ErrorCode::NotFound => None,
        Err(error) => return checked(Err(error)),
    };
    if let Some(entry) = entry {
        checked(index.add(&IndexEntry {
            ctime: IndexTime::new(0, 0),
            mtime: IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: entry.filemode() as u32,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: entry.id(),
            flags: path.len() as u16,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        }))
    } else {
        checked(index.remove_path(relative))
    }
}

fn commit(
    workspace: &Workspace,
    revision: &str,
    name: &str,
    email: &str,
    message: &str,
) -> Result<()> {
    let name = name.trim();
    let email = email.trim();
    let message = message.trim();
    if name.is_empty()
        || name.len() > 120
        || name.chars().any(char::is_control)
        || email.len() > 254
        || !email.contains('@')
        || email.chars().any(char::is_whitespace)
        || email.contains(['<', '>', '\0'])
        || message.is_empty()
        || message.len() > 4096
        || message.contains('\0')
    {
        return Err(Error::Git(
            "GIT_COMMIT_INPUT",
            "Provide an author name, author email and commit message",
        ));
    }
    let signature = checked(Signature::now(name, email))?;
    let _index_lock = IndexLock::acquire(&workspace.root.join(".git"))?;
    let repo = &workspace.repository;
    let mut transaction = checked(repo.transaction())?;
    checked(transaction.lock_ref("HEAD"))?;
    let head = checked(repo.find_reference("HEAD"))?;
    let target = checked(head.symbolic_target())?
        .filter(|name| name.starts_with("refs/heads/"))
        .ok_or(Error::Git(
            "GIT_DETACHED",
            "Switch to a local branch before committing",
        ))?;
    checked(transaction.lock_ref(target))?;
    let snapshot = ready(workspace, revision)?;
    if !snapshot.entries.iter().any(|entry| entry.staged.is_some()) {
        return Err(Error::Git(
            "GIT_NOT_STAGED",
            "Stage a change before committing",
        ));
    }
    let mut index = checked(repo.index())?;
    let tree = checked(repo.find_tree(checked(index.write_tree())?))?;
    let parent = workspace.head()?;
    let parents = parent.iter().collect::<Vec<_>>();
    let id = checked(repo.commit(None, &signature, &signature, message, &tree, &parents))?;
    checked(transaction.set_target(target, id, Some(&signature), "commit from Forge"))?;
    checked(transaction.commit())
}

fn switch_branch(workspace: &Workspace, revision: &str, name: &str) -> Result<()> {
    let initial = ready(workspace, revision)?;
    if !initial.branches.iter().any(|branch| branch.name == name) {
        return Err(Error::Git("GIT_BRANCH", "Choose an existing local branch"));
    }
    if initial.branch.as_deref() == Some(name) {
        return Ok(());
    }
    if !initial.entries.is_empty() {
        return Err(Error::Git(
            "GIT_DIRTY",
            "Commit or move local changes before switching branches",
        ));
    }
    let repo = &workspace.repository;
    let mut transaction = checked(repo.transaction())?;
    checked(transaction.lock_ref("HEAD"))?;
    let current_head = checked(repo.find_reference("HEAD"))?;
    if let Some(current) = checked(current_head.symbolic_target())? {
        checked(transaction.lock_ref(current))?;
    }
    let branch = checked(repo.find_branch(name, BranchType::Local))?;
    let reference = checked(branch.get().name())?;
    checked(transaction.lock_ref(reference))?;
    ready(workspace, revision)?;
    let tree = checked(branch.get().peel_to_tree())?;
    let mut valid = true;
    checked(tree.walk(TreeWalkMode::PreOrder, |folder, entry| {
        let name = entry.name().unwrap_or_default();
        let mode = entry.filemode();
        if name.is_empty()
            || validate_relative_path(&format!("{folder}{name}")).is_err()
            || !matches!(mode, 0o040000 | 0o100644 | 0o100755)
        {
            valid = false;
            TreeWalkResult::Abort
        } else {
            TreeWalkResult::Ok
        }
    }))?;
    if !valid {
        return Err(unsupported_path());
    }
    let mut checkout = CheckoutBuilder::new();
    checkout.safe().overwrite_ignored(false);
    repo.checkout_tree(tree.as_object(), Some(&mut checkout)).map_err(|_| Error::Git(
        "GIT_CHECKOUT",
        "Git could not complete the safe checkout. Refresh and inspect the working tree before trying again",
    ))?;
    checked(transaction.set_symbolic_target("HEAD", reference, None, "checkout from Forge"))?;
    transaction.commit().map_err(|_| Error::Git(
        "GIT_CHECKOUT",
        "The files were checked out but Git could not move HEAD. Inspect the working tree in your Git client",
    ))
}

struct IndexLock {
    path: PathBuf,
    file: Option<File>,
    published: bool,
}

impl IndexLock {
    fn acquire(admin: &Path) -> Result<Self> {
        let path = admin.join("index.lock");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    Error::Git(
                        "GIT_CHANGED",
                        "Another Git writer locked the index. Refresh and try again",
                    )
                } else {
                    index_error()
                }
            })?;
        Ok(Self {
            path,
            file: Some(file),
            published: false,
        })
    }

    fn publish(mut self, source: &Path, index: &Path) -> Result<()> {
        let mut source = File::open(source).map_err(|_| index_error())?;
        let mut file = self.file.take().expect("Git index lock");
        io::copy(&mut source, &mut file).map_err(|_| index_error())?;
        file.sync_all().map_err(|_| index_error())?;
        drop(file);
        fs::rename(&self.path, index).map_err(|_| index_error())?;
        self.published = true;
        Ok(())
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct ScratchIndex {
    path: PathBuf,
}

impl ScratchIndex {
    fn copy(admin: &Path) -> Result<Self> {
        let folder = admin.join(format!("forge-index-{}", Uuid::new_v4()));
        fs::create_dir(&folder).map_err(|_| index_error())?;
        let scratch = Self {
            path: folder.join("index"),
        };
        let actual = admin.join("index");
        if let Err(error) = fs::copy(&actual, &scratch.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            return Err(index_error());
        }
        Ok(scratch)
    }
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        if let Some(directory) = self.path.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}

fn index_error() -> Error {
    Error::Git(
        "GIT_IO",
        "Git could not write the index. Inspect any filesystem error and try again",
    )
}

use std::{
    fs,
    path::{Path, PathBuf},
};

use forge_core::git::{Action, DiffSide, diff, inspect, mutate};
use git2::{IndexAddOption, Repository, Signature};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("forge-git-test-{}", Uuid::new_v4())))
    }

    fn root(&self) -> &Path {
        &self.0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn value(input: impl Serialize) -> Value {
    serde_json::to_value(input).unwrap()
}

fn revision(input: &Value) -> &str {
    input["revision"].as_str().unwrap()
}

fn publish_fixture(repo: &Repository, message: &str) {
    let mut index = repo.index().unwrap();
    index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let author = Signature::now("Forge fixture", "fixture@example.invalid").unwrap();
    let parent = repo.head().and_then(|head| head.peel_to_commit()).ok();
    let parents = parent.iter().collect::<Vec<_>>();
    repo.commit(Some("HEAD"), &author, &author, message, &tree, &parents)
        .unwrap();
}

#[test]
fn git_index_commit_and_checkout_follow_reviewed_worktree() {
    let fixture = Fixture::new();
    let root = fixture.root();
    let repo = Repository::init(root).unwrap();
    repo.set_head("refs/heads/main").unwrap();
    let file = root.join("file.txt");
    fs::write(&file, "main\n").unwrap();

    let base = value(inspect(root).unwrap());
    assert_eq!(base["branch"], "main");
    assert!(base["head"].is_null());
    assert_eq!(base["entries"][0]["unstaged"], "added");
    let preview = value(diff(root, "file.txt", DiffSide::Unstaged, revision(&base)).unwrap());
    assert!(preview["text"].as_str().unwrap().contains("+main"));

    let stage = || Action::Stage {
        path: "file.txt".into(),
    };
    let staged = value(mutate(root, revision(&base), stage()).unwrap());
    assert_eq!(staged["entries"][0]["staged"], "added");
    assert_eq!(
        mutate(root, revision(&base), stage()).err().unwrap().code(),
        "GIT_CHANGED"
    );
    let unstaged = value(
        mutate(
            root,
            revision(&staged),
            Action::Unstage {
                path: "file.txt".into(),
            },
        )
        .unwrap(),
    );
    assert_eq!(unstaged["entries"][0]["unstaged"], "added");
    let staged = value(mutate(root, revision(&unstaged), stage()).unwrap());
    let committed = value(
        mutate(
            root,
            revision(&staged),
            Action::Commit {
                author_name: "Forge fixture".into(),
                author_email: "fixture@example.invalid".into(),
                message: "first from Forge".into(),
            },
        )
        .unwrap(),
    );
    assert_eq!(committed["history"][0]["subject"], "first from Forge");
    assert_eq!(committed["entries"], serde_json::json!([]));

    let main = repo
        .find_commit(committed["head"].as_str().unwrap().parse().unwrap())
        .unwrap();
    repo.branch("other", &main, false).unwrap();
    repo.set_head("refs/heads/other").unwrap();
    fs::write(&file, "other\n").unwrap();
    publish_fixture(&repo, "other branch");
    repo.set_head("refs/heads/main").unwrap();
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    repo.checkout_head(Some(&mut checkout)).unwrap();

    let switch = || Action::SwitchBranch {
        branch: "other".into(),
    };
    fs::write(&file, "local change\n").unwrap();
    let dirty = value(inspect(root).unwrap());
    assert_eq!(
        mutate(root, revision(&dirty), switch())
            .err()
            .unwrap()
            .code(),
        "GIT_DIRTY"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "local change\n");

    fs::remove_file(&file).unwrap();
    let deleted = value(inspect(root).unwrap());
    let staged = value(mutate(root, revision(&deleted), stage()).unwrap());
    assert_eq!(staged["entries"][0]["staged"], "deleted");
    let restored = value(
        mutate(
            root,
            revision(&staged),
            Action::Unstage {
                path: "file.txt".into(),
            },
        )
        .unwrap(),
    );
    assert_eq!(restored["entries"][0]["unstaged"], "deleted");
    assert!(!file.exists());

    fs::write(&file, "main\n").unwrap();
    let clean = value(inspect(root).unwrap());
    let switched = value(mutate(root, revision(&clean), switch()).unwrap());
    assert_eq!(switched["branch"], "other");
    assert_eq!(fs::read_to_string(&file).unwrap(), "other\n");
}

#[test]
fn git_respects_an_external_index_lock_and_never_searches_parent() {
    let fixture = Fixture::new();
    let root = fixture.root();
    let repo = Repository::init(root).unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    assert_eq!(
        inspect(&root.join("nested")).err().unwrap().code(),
        "GIT_REPOSITORY"
    );
    fs::write(root.join("file.txt"), "fixture\n").unwrap();
    let base = value(inspect(root).unwrap());
    let lock = repo.path().join("index.lock");
    fs::write(&lock, "externally owned\n").unwrap();
    let reply = mutate(
        root,
        revision(&base),
        Action::Stage {
            path: "file.txt".into(),
        },
    );
    assert_eq!(reply.err().unwrap().code(), "GIT_CHANGED");
    assert_eq!(fs::read_to_string(lock).unwrap(), "externally owned\n");
}

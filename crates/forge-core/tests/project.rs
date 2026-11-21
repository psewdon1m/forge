use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use forge_core::{
    Change, Content, EditRequest, Error, Node, Placement, Position, Project, Viewport,
};
use forge_core::{
    create_settings_backup, inspect_settings_backup, read_settings_backup,
    settings::{Preferences, ProfileSettings},
};
use rusqlite::Connection;
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("forge-core-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let expected = std::env::temp_dir();
        assert_eq!(self.root.parent(), Some(expected.as_path()));
        assert!(
            self.root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("forge-core-test-")
        );
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn edit(base_revision: i64, change: Change) -> EditRequest {
    EditRequest {
        operation_id: Uuid::new_v4(),
        base_revision,
        change,
    }
}

#[test]
fn backup_restores_logical_history_and_files_under_a_new_project_id() {
    let fixture = Fixture::new();
    let source = fixture.root.join("Source");
    fs::create_dir(&source).unwrap();
    let mut project = Project::create(&source, "Original".into()).unwrap();
    let node = Node {
        id: Uuid::new_v4(),
        label: "Brief".into(),
        position: Position { x: 10., y: 12. },
        content: Content::Note {
            text: "Keep this quote".into(),
        },
    };
    project.apply(edit(0, Change::Add { node })).unwrap();
    project
        .apply(edit(
            1,
            Change::RenameProject {
                title: "Renamed".into(),
            },
        ))
        .unwrap();
    let viewport = Viewport {
        x: 22.,
        y: -27.,
        zoom: 1.6,
    };
    project.save_viewport(viewport).unwrap();
    let original = project.view().unwrap();
    fs::create_dir_all(source.join("Notes/Empty")).unwrap();
    fs::write(source.join("Notes/brief.md"), "original bytes").unwrap();
    fs::write(source.join(".env"), "synthetic-secret").unwrap();
    let archive = fixture.root.join("project.zip");
    assert_eq!(
        project.create_backup(&archive, 1).unwrap_err().code(),
        "REVISION_CONFLICT"
    );
    assert!(!archive.exists());
    assert_eq!(
        project
            .create_backup(&source.join("inside.zip"), 2)
            .unwrap_err()
            .code(),
        "BACKUP_PATH"
    );
    let created = project.create_backup(&archive, 2).unwrap();
    let inspected = Project::inspect_backup(&archive).unwrap();
    assert_eq!(created.archive_sha256, inspected.archive_sha256);
    assert_eq!(
        (inspected.revision, inspected.revisions, inspected.files),
        (2, 3, 1)
    );
    assert_eq!(
        project.create_backup(&archive, 2).unwrap_err().code(),
        "EXPORT_EXISTS"
    );
    assert_eq!(
        Project::restore_backup(&archive, &source, &inspected.archive_sha256)
            .unwrap_err()
            .code(),
        "EXPORT_EXISTS"
    );
    let copy = fixture.root.join("Restored");
    assert_eq!(
        Project::restore_backup(
            &archive,
            &source.join("Nested copy"),
            &inspected.archive_sha256
        )
        .unwrap_err()
        .code(),
        "BACKUP_PATH"
    );
    assert_eq!(
        Project::restore_backup(&archive, &copy, &"0".repeat(64))
            .unwrap_err()
            .code(),
        "BACKUP_CHANGED"
    );
    assert!(!copy.exists());
    let mut restored = Project::restore_backup(&archive, &copy, &inspected.archive_sha256).unwrap();
    assert_ne!(restored.space.project_id, original.space.project_id);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(copy.join(".forge/project.json")).unwrap()).unwrap();
    assert_eq!(
        manifest["sourceProjectId"],
        original.space.project_id.to_string()
    );
    restored.space.project_id = original.space.project_id;
    assert_eq!(restored.space, original.space);
    assert_eq!(restored.viewport, viewport);
    assert_eq!(
        fs::read(copy.join("Notes/brief.md")).unwrap(),
        b"original bytes"
    );
    assert!(copy.join("Notes/Empty").is_dir());
    assert!(!copy.join(".env").exists());
    assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
    let mut reopened = Project::open(&copy).unwrap();
    assert_eq!(reopened.revisions(None, 10).unwrap().len(), 3);
    reopened.apply(edit(2, Change::Undo)).unwrap();
    assert_eq!(reopened.view().unwrap().space.title, "Original");
    assert_eq!(project.view().unwrap().space, original.space);
}

#[test]
fn backup_rejects_wrong_checksum_future_schema_and_unsafe_member() {
    let fixture = Fixture::new();
    let source = fixture.root.join("Source");
    fs::create_dir(&source).unwrap();
    let project = Project::create(&source, "Original".into()).unwrap();
    fs::write(source.join("brief.txt"), b"original").unwrap();
    let archive = fixture.root.join("good.zip");
    let info = project.create_backup(&archive, 0).unwrap();
    let bad = fixture.root.join("bad.zip");
    let copy = fixture.root.join("Restored");
    rewrite_archive(&archive, &bad, |name, bytes| {
        if name == "files/brief.txt" {
            bytes[0] = b'X';
        }
    });
    assert_eq!(
        Project::restore_backup(&bad, &copy, &info.archive_sha256)
            .unwrap_err()
            .code(),
        "BACKUP_CHECKSUM"
    );
    assert!(!copy.exists());
    rewrite_archive(&archive, &bad, |name, bytes| {
        if name == "manifest.json" {
            let mut data: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            data["schemaVersion"] = 2.into();
            *bytes = serde_json::to_vec(&data).unwrap();
        }
    });
    assert_eq!(
        Project::inspect_backup(&bad).unwrap_err().code(),
        "SCHEMA_UNSUPPORTED"
    );
    rewrite_archive(&archive, &bad, |name, _| {
        if name == "files/brief.txt" {
            *name = "files/../outside.txt".into();
        }
    });
    assert_eq!(
        Project::inspect_backup(&bad).unwrap_err().code(),
        "BACKUP_INVALID"
    );
    let broken_navigation = b"[0,-1,null]\n";
    let broken_digest = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(broken_navigation))
    };
    rewrite_archive(&archive, &bad, |name, bytes| {
        if name == "data/navigation.jsonl" {
            *bytes = broken_navigation.to_vec();
        } else if name == "manifest.json" {
            let mut data: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            let record = &mut data["members"]["data/navigation.jsonl"];
            record["bytes"] = broken_navigation.len().into();
            record["records"] = 1.into();
            record["sha256"] = broken_digest.clone().into();
            *bytes = serde_json::to_vec(&data).unwrap();
        }
    });
    let inspected = Project::inspect_backup(&bad).unwrap();
    assert!(Project::restore_backup(&bad, &copy, &inspected.archive_sha256).is_err());
    assert!(!copy.exists());
    assert!(fs::read_dir(&fixture.root).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".forge-backup-")
    }));
    assert!(!fixture.root.join("outside.txt").exists());
    assert_eq!(fs::read(source.join("brief.txt")).unwrap(), b"original");
}

fn rewrite_archive(source: &Path, output: &Path, change: impl Fn(&mut String, &mut Vec<u8>)) {
    let mut source = zip::ZipArchive::new(fs::File::open(source).unwrap()).unwrap();
    let mut output = zip::ZipWriter::new(fs::File::create(output).unwrap());
    for index in 0..source.len() {
        let mut entry = source.by_index(index).unwrap();
        let mut name = entry.name().unwrap().into_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        change(&mut name, &mut bytes);
        output
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        output.write_all(&bytes).unwrap();
    }
    output.finish().unwrap();
}

#[test]
fn backup_rejects_members_that_exceed_the_expansion_quota() {
    let fixture = Fixture::new();
    let path = fixture.root.join("ratio.zip");
    let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for control in [
        "manifest.json",
        "data/project.json",
        "data/folders.jsonl",
        "history/revisions.jsonl",
        "data/navigation.jsonl",
        "data/assets.jsonl",
        "data/imports.jsonl",
        "data/analyses.jsonl",
    ] {
        archive.start_file(control, stored).unwrap();
    }
    let deflated = stored.compression_method(zip::CompressionMethod::Deflated);
    archive.start_file("files/repeated.txt", deflated).unwrap();
    archive.write_all(&vec![b'A'; 1024 * 1024]).unwrap();
    archive.finish().unwrap();
    assert_eq!(
        Project::inspect_backup(&path).unwrap_err().code(),
        "BACKUP_LIMIT"
    );
}

#[test]
fn settings_backup_is_portable_and_applies_only_to_the_expected_revision() {
    let fixture = Fixture::new();
    let source_path = fixture.root.join("Source profile");
    let destination_path = fixture.root.join("Destination profile");
    let mut source = ProfileSettings::open(&source_path).unwrap();
    let mut destination = ProfileSettings::open(&destination_path).unwrap();
    let defaults = destination.read().unwrap();
    assert!(defaults.preferences.snap_to_grid);
    let source_change = source
        .replace(
            0,
            Preferences {
                snap_to_grid: false,
            },
        )
        .unwrap();
    let archive = fixture.root.join("settings.zip");
    let backup = create_settings_backup(&archive, source_change.preferences).unwrap();
    assert!(!backup.snap_to_grid);
    assert_eq!(
        backup.archive_sha256,
        inspect_settings_backup(&archive).unwrap().archive_sha256
    );
    assert_eq!(
        create_settings_backup(&archive, defaults.preferences)
            .unwrap_err()
            .code(),
        "EXPORT_EXISTS"
    );
    assert_eq!(
        read_settings_backup(&archive, &"0".repeat(64))
            .err()
            .unwrap()
            .code(),
        "BACKUP_CHANGED"
    );
    let archived = read_settings_backup(&archive, &backup.archive_sha256).unwrap();

    let edit = destination.replace(0, defaults.preferences).unwrap();
    assert_eq!(
        destination
            .replace(defaults.revision, archived)
            .err()
            .unwrap()
            .code(),
        "SETTINGS_CHANGED"
    );
    assert!(destination.read().unwrap().preferences.snap_to_grid);
    let restored = destination.replace(edit.revision, archived).unwrap();
    assert!(!restored.preferences.snap_to_grid);
    drop(destination);
    assert_eq!(
        ProfileSettings::open(&destination_path)
            .unwrap()
            .read()
            .unwrap()
            .revision,
        restored.revision
    );
    assert_eq!(source.read().unwrap().revision, source_change.revision);
}

#[test]
fn settings_backup_rejects_changed_member_and_future_envelope_before_restore() {
    let fixture = Fixture::new();
    let archive = fixture.root.join("settings.zip");
    create_settings_backup(
        &archive,
        Preferences {
            snap_to_grid: false,
        },
    )
    .unwrap();
    let modified = fixture.root.join("modified.zip");
    rewrite_archive(&archive, &modified, |name, bytes| {
        if name == "data/settings.json" {
            *bytes = String::from_utf8_lossy(bytes)
                .replace("false", "true ")
                .into_bytes();
        }
    });
    assert_eq!(
        inspect_settings_backup(&modified).unwrap_err().code(),
        "BACKUP_CHECKSUM"
    );
    rewrite_archive(&archive, &modified, |name, bytes| {
        if name == "manifest.json" {
            let mut data: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            data["schemaVersion"] = 2.into();
            *bytes = serde_json::to_vec(&data).unwrap();
        }
    });
    assert_eq!(
        inspect_settings_backup(&modified).unwrap_err().code(),
        "SCHEMA_UNSUPPORTED"
    );
}

#[test]
fn creation_is_local_and_reopen_preserves_state_and_viewport() {
    let fixture = Fixture::new();
    let mut project = Project::create(&fixture.root, "Съёмка".into()).unwrap();
    let initial = project.view().unwrap();
    assert_eq!(initial.revision, 0);
    assert!(initial.space.nodes.is_empty());
    let note = Node {
        id: Uuid::new_v4(),
        label: "Brief".into(),
        position: Position { x: -8.0, y: 20.0 },
        content: Content::Note {
            text: "Light, main focus".into(),
        },
    };
    assert_eq!(
        project
            .apply(edit(0, Change::Add { node: note.clone() }))
            .unwrap(),
        1
    );
    let view = Viewport {
        x: 28.0,
        y: -40.0,
        zoom: 1.25,
    };
    project.save_viewport(view).unwrap();
    drop(project);
    let reopened = Project::open(&fixture.root).unwrap().view().unwrap();
    assert_eq!(reopened.space.project_id, initial.space.project_id);
    assert_eq!(reopened.space.title, "Съёмка");
    assert_eq!(reopened.revision, 1);
    assert_eq!(reopened.space.nodes, [note]);
    assert_eq!(reopened.viewport, view);
}

#[test]
fn one_writer_replay_and_conflict_protect_the_head_revision() {
    let fixture = Fixture::new();
    let mut project = Project::create(&fixture.root, "Before".into()).unwrap();
    assert!(matches!(Project::open(&fixture.root), Err(Error::Locked)));
    let rename = edit(
        0,
        Change::RenameProject {
            title: "After".into(),
        },
    );
    assert_eq!(project.apply(rename.clone()).unwrap(), 1);
    assert_eq!(project.apply(rename.clone()).unwrap(), 1);
    let conflicting_id = EditRequest {
        change: Change::RenameProject {
            title: "Different".into(),
        },
        ..rename
    };
    assert!(matches!(
        project.apply(conflicting_id),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        project.apply(edit(
            0,
            Change::RenameProject {
                title: "Stale".into()
            }
        )),
        Err(Error::StaleRevision { current: 1 })
    ));
    assert_eq!(project.view().unwrap().space.title, "After");
    assert_eq!(project.revisions(None, 20).unwrap().len(), 2);
}

#[test]
fn invalid_multi_object_move_cannot_persist_a_partial_revision() {
    let fixture = Fixture::new();
    let mut project = Project::create(&fixture.root, "Project".into()).unwrap();
    let node = Node {
        id: Uuid::new_v4(),
        label: "Anchor".into(),
        position: Position { x: 0.0, y: 0.0 },
        content: Content::Note {
            text: String::new(),
        },
    };
    project
        .apply(edit(0, Change::Add { node: node.clone() }))
        .unwrap();
    let position = Position { x: 40.0, y: 20.0 };
    let movement = Change::MoveSelection {
        placements: vec![
            Placement {
                id: node.id,
                position,
            },
            Placement {
                id: Uuid::new_v4(),
                position,
            },
        ],
    };
    assert!(matches!(
        project.apply(edit(1, movement)),
        Err(Error::Invalid(_))
    ));
    let current = project.view().unwrap();
    assert_eq!(current.revision, 1);
    assert_eq!(current.space.nodes, [node]);
}

#[test]
fn undo_and_redo_persist_across_reopen_and_new_edits_clear_redo() {
    let fixture = Fixture::new();
    let mut project = Project::create(&fixture.root, "Original".into()).unwrap();
    project
        .apply(edit(
            0,
            Change::RenameProject {
                title: "First".into(),
            },
        ))
        .unwrap();
    project
        .apply(edit(
            1,
            Change::RenameProject {
                title: "Second".into(),
            },
        ))
        .unwrap();
    project.apply(edit(2, Change::Undo)).unwrap();
    project.apply(edit(3, Change::Undo)).unwrap();
    drop(project);
    let mut project = Project::open(&fixture.root).unwrap();
    assert_eq!(project.view().unwrap().space.title, "Original");
    assert!(!project.view().unwrap().can_undo);
    assert!(project.view().unwrap().can_redo);
    project.apply(edit(4, Change::Redo)).unwrap();
    assert_eq!(project.view().unwrap().space.title, "First");
    project.apply(edit(5, Change::Redo)).unwrap();
    assert_eq!(project.view().unwrap().space.title, "Second");
    project.apply(edit(6, Change::Undo)).unwrap();
    project
        .apply(edit(
            7,
            Change::RenameProject {
                title: "New branch".into(),
            },
        ))
        .unwrap();
    assert!(matches!(
        project.apply(edit(8, Change::Redo)),
        Err(Error::Invalid(_))
    ));
    assert_eq!(project.view().unwrap().space.title, "New branch");
    assert_eq!(project.revisions(None, 15).unwrap().len(), 9);
}

#[test]
fn revision_restore_creates_a_new_revision_and_preserves_unknown_payload() {
    let fixture = Fixture::new();
    let mut project = Project::create(&fixture.root, "Project".into()).unwrap();
    let portal = Node {
        id: Uuid::new_v4(),
        label: "Unresolved".into(),
        position: Position { x: 0.0, y: 0.0 },
        content: Content::Portal {
            plain_id: Uuid::new_v4(),
            type_id: "future.module".into(),
            schema_version: 7,
            payload: "{ \"z\": 10, \"a\": [ 2, 1 ] }".into(),
        },
    };
    project
        .apply(edit(
            0,
            Change::Add {
                node: portal.clone(),
            },
        ))
        .unwrap();
    let duplicate = Node {
        id: Uuid::new_v4(),
        ..portal.clone()
    };
    assert!(matches!(
        project.apply(edit(1, Change::Add { node: duplicate })),
        Err(Error::Invalid(_))
    ));
    project
        .apply(edit(1, Change::ArchiveNode { id: portal.id }))
        .unwrap();
    project
        .apply(edit(2, Change::RestoreRevision { revision: 1 }))
        .unwrap();
    let restored = project.view().unwrap();
    assert_eq!(restored.revision, 3);
    assert_eq!(restored.space.nodes, [portal]);
    assert_eq!(project.revisions(Some(3), 2).unwrap()[0].revision, 2);
}

#[test]
fn nonempty_folder_and_unreadable_state_fail_without_overwriting() {
    let fixture = Fixture::new();
    let existing = fixture.root.join("preserve.txt");
    fs::write(&existing, b"original").unwrap();
    assert!(matches!(
        Project::create(&fixture.root, "Project".into()),
        Err(Error::AlreadyExists)
    ));
    assert_eq!(fs::read(&existing).unwrap(), b"original");
    fs::remove_file(existing).unwrap();
    drop(Project::create(&fixture.root, "Project".into()).unwrap());
    let database = Connection::open(fixture.root.join(".forge/workspace.sqlite")).unwrap();
    database
        .execute(
            "UPDATE revisions SET digest=?1 WHERE revision=0",
            ["0".repeat(64)],
        )
        .unwrap();
    assert!(matches!(
        Project::open(&fixture.root),
        Err(Error::Corrupt(_))
    ));
    database.pragma_update(None, "user_version", 25).unwrap();
    assert!(matches!(
        Project::open(&fixture.root),
        Err(Error::UnsupportedSchema(25))
    ));
}

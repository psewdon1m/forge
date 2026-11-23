use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

use forge_core::{
    Change, Content, EditRequest, ImportRequest, Node, Position, Project, RecoveredUpdateBackup,
    UpdateBackupReceipt, UpdateBackupScope, open_update_backup, prepare_update_backup,
    settings::{Preferences, ProfileSettings},
};
use uuid::Uuid;
use zip::ZipArchive;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("forge-update-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn project(&self, folder: &str) -> Project {
        let root = self.0.join(folder);
        fs::create_dir(&root).unwrap();
        Project::create(&root, folder.into()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn scope(settings_revision: i64, projects: &[(Uuid, i64)]) -> UpdateBackupScope {
    UpdateBackupScope {
        source_version: env!("CARGO_PKG_VERSION").into(),
        job_id: Uuid::new_v4(),
        target_version: "0.0.2-qualification".into(),
        target_sha256: "ab".repeat(32),
        settings_revision,
        projects: BTreeMap::from_iter(projects.iter().copied()),
    }
}

fn project_manifest(root: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(root.join(".forge/project.json")).unwrap()).unwrap()
}

#[test]
fn scoped_update_zip_reopens_exact_saved_bytes_and_stages_original_project_identity() {
    let fixture = Fixture::new();
    let mut original = fixture.project("Original");
    let mut secondary = fixture.project("Secondary");
    let original_id = original.view().unwrap().space.project_id;
    let revision = original
        .apply(EditRequest {
            operation_id: Uuid::new_v4(),
            base_revision: 0,
            change: Change::Add {
                node: Node {
                    id: Uuid::new_v4(),
                    label: "Approved quote".into(),
                    position: Position { x: 30., y: 44. },
                    content: Content::Note {
                        text: "A user-saved quote".into(),
                    },
                },
            },
        })
        .unwrap();
    fs::write(fixture.0.join("Original/brief.txt"), "approved source file").unwrap();
    let external_file = fixture.0.join("registered.txt");
    fs::write(&external_file, b"registered resource bytes").unwrap();
    let imported = original
        .import_batch_with_progress(
            ImportRequest {
                operation_id: Uuid::new_v4(),
                base_revision: revision,
                paths: vec![external_file],
                position: Position { x: 60., y: 20. },
            },
            None,
            |_| Ok(()),
        )
        .unwrap();
    let revision = imported.revision;
    let asset = imported.items[0].asset.as_ref().unwrap();
    let blob_name = format!("asset-{}.txt", asset.version_id);
    let original_zip = fixture.0.join("original.zip");
    let original_receipt = original.create_backup(&original_zip, revision).unwrap();
    let source = fixture.0.join("Previously restored");
    Project::restore_backup(&original_zip, &source, &original_receipt.archive_sha256).unwrap();
    fs::write(source.join(".env"), "FORGE_SYNTHETIC_PRIVATE=never-export").unwrap();
    let mut primary = Project::open(&source).unwrap();
    let original_view = primary.view().unwrap();
    let original_history = serde_json::to_value(primary.revisions(None, 10).unwrap()).unwrap();
    let primary_id = original_view.space.project_id;
    let secondary_id = secondary.view().unwrap().space.project_id;
    let profile = fixture.0.join("Profile");
    let mut settings = ProfileSettings::open(&profile).unwrap();
    settings
        .replace(
            0,
            Preferences {
                snap_to_grid: false,
            },
        )
        .unwrap();

    let scope = scope(1, &[(primary_id, revision), (secondary_id, 0)]);
    let job = scope.job_id;
    let mut prepared =
        prepare_update_backup(&mut settings, scope, vec![&mut secondary, &mut primary]).unwrap();
    assert_eq!(prepared.info().job_id(), job);
    assert_eq!(prepared.info().settings_revision(), 1);
    assert_eq!(prepared.info().projects().len(), 2);
    assert_eq!(prepared.info().target().0, "0.0.2-qualification");
    assert!(matches!(
        Project::open(&source),
        Err(forge_core::Error::Locked)
    ));
    let mut second_settings = ProfileSettings::open(&profile).unwrap();
    assert!(
        second_settings
            .replace(1, Preferences { snap_to_grid: true })
            .is_err()
    );
    let user_zip = fixture.0.join("update.zip");
    assert!(!user_zip.exists());
    let receipt = prepared.save(&user_zip).unwrap();
    let bytes = fs::read(&user_zip).unwrap();
    assert_eq!(prepared.for_install(&receipt).unwrap(), bytes);
    let mut members = ZipArchive::new(Cursor::new(&bytes)).unwrap();
    let mut manifest = String::new();
    members
        .by_name("manifest.json")
        .unwrap()
        .read_to_string(&mut manifest)
        .unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["scope"], "update");
    assert_eq!(manifest["format"], "forge-project-backup");
    assert!(
        members
            .by_name(&format!("projects/{primary_id}/files/brief.txt"))
            .is_ok()
    );
    assert!(
        !bytes
            .windows(b"never-export".len())
            .any(|bytes| bytes == b"never-export")
    );
    let mut changed = serde_json::to_value(&receipt).unwrap();
    changed["info"]["recovery"]["targetVersion"] = "0.0.3".into();
    let wrong_receipt: UpdateBackupReceipt = serde_json::from_value(changed).unwrap();
    assert_eq!(
        open_update_backup(&user_zip, &wrong_receipt)
            .err()
            .unwrap()
            .code(),
        "BACKUP_RECEIPT"
    );
    let mut tampered = bytes.clone();
    tampered[0] ^= 1;
    fs::write(&user_zip, &tampered).unwrap();
    assert_eq!(
        prepared.for_install(&receipt).unwrap_err().code(),
        "BACKUP_RECEIPT"
    );
    fs::write(&user_zip, &bytes).unwrap();
    assert_eq!(
        RecoveredUpdateBackup::from_bytes(tampered, &receipt)
            .err()
            .unwrap()
            .code(),
        "BACKUP_RECEIPT"
    );
    drop(prepared);

    second_settings
        .replace(1, Preferences { snap_to_grid: true })
        .unwrap();
    let mut recovered = open_update_backup(&user_zip, &receipt).unwrap();
    let staged = fixture.0.join("Ready for rollback");
    let view = recovered.stage_project(primary_id, &staged).unwrap();
    assert_eq!(view.space, original_view.space);
    assert_eq!(view.revision, revision);
    assert_eq!(
        project_manifest(&staged)["sourceProjectId"],
        original_id.to_string()
    );
    let staged_project = Project::open(&staged).unwrap();
    assert_eq!(
        serde_json::to_value(staged_project.revisions(None, 10).unwrap()).unwrap(),
        original_history
    );
    assert_eq!(
        fs::read(staged.join("brief.txt")).unwrap(),
        b"approved source file"
    );
    assert_eq!(
        fs::read(staged.join("assets").join(blob_name)).unwrap(),
        b"registered resource bytes"
    );
    assert!(!staged.join(".env").exists());
    assert_eq!(
        fs::read(source.join(".env")).unwrap(),
        b"FORGE_SYNTHETIC_PRIVATE=never-export"
    );
    let secondary_view = recovered
        .stage_project(secondary_id, &fixture.0.join("Secondary rollback"))
        .unwrap();
    assert_eq!(secondary_view.space.project_id, secondary_id);
    let applied = second_settings.replace(2, recovered.preferences()).unwrap();
    assert!(!applied.preferences.snap_to_grid);
}

#[test]
fn update_preparation_rejects_mismatched_scope_changed_source_and_oversize() {
    let fixture = Fixture::new();
    let mut project = fixture.project("Project");
    let id = project.view().unwrap().space.project_id;
    let mut settings = ProfileSettings::open(&fixture.0.join("Profile")).unwrap();
    let missing = scope(0, &[(id, 0), (Uuid::new_v4(), 0)]);
    assert_eq!(
        prepare_update_backup(&mut settings, missing, vec![&mut project])
            .err()
            .unwrap()
            .code(),
        "BACKUP_SCOPE"
    );
    let stale = scope(0, &[(id, 1)]);
    assert_eq!(
        prepare_update_backup(&mut settings, stale, vec![&mut project])
            .err()
            .unwrap()
            .code(),
        "REVISION_CONFLICT"
    );
    let document = fixture.0.join("Project/brief.txt");
    fs::write(&document, b"old").unwrap();
    let mut captured =
        prepare_update_backup(&mut settings, scope(0, &[(id, 0)]), vec![&mut project]).unwrap();
    fs::write(&document, b"different length").unwrap();
    let destination = fixture.0.join("update.zip");
    assert_eq!(
        captured.save(&destination).unwrap_err().code(),
        "SOURCE_CHANGED"
    );
    assert!(!destination.exists());
    drop(captured);

    File::create(document)
        .unwrap()
        .set_len(128 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        prepare_update_backup(&mut settings, scope(0, &[(id, 0)]), vec![&mut project])
            .err()
            .unwrap()
            .code(),
        "BACKUP_LIMIT"
    );
    assert!(settings.read().unwrap().preferences.snap_to_grid);
    assert!(!destination.exists());
}

#[test]
fn settings_only_candidate_uses_the_same_receipt_and_recovery_path() {
    let fixture = Fixture::new();
    let mut settings = ProfileSettings::open(&fixture.0.join("Profile")).unwrap();
    let mut prepared = prepare_update_backup(&mut settings, scope(0, &[]), Vec::new()).unwrap();
    assert!(prepared.info().projects().is_empty());
    let output = fixture.0.join("settings-only-update.zip");
    let receipt = prepared.save(&output).unwrap();
    let verified = prepared.for_install(&receipt).unwrap();
    let recovered = RecoveredUpdateBackup::from_bytes(verified.to_vec(), &receipt).unwrap();
    assert!(recovered.preferences().snap_to_grid);
    drop(prepared);

    let current = settings
        .replace(
            0,
            Preferences {
                snap_to_grid: false,
            },
        )
        .unwrap();
    let job = receipt.info.job_id();
    let pending = settings.begin_replacement(current.revision).unwrap();
    assert_eq!(pending.restored_revision(job).unwrap(), None);
    drop(pending);
    assert!(!settings.read().unwrap().preferences.snap_to_grid);

    let restored = settings
        .begin_replacement(current.revision)
        .unwrap()
        .restore_for_update(recovered.preferences(), job)
        .unwrap();
    assert_eq!(restored.revision, current.revision + 1);
    assert!(restored.preferences.snap_to_grid);
    drop(settings);

    let mut reopened = ProfileSettings::open(&fixture.0.join("Profile")).unwrap();
    assert!(reopened.read().unwrap().preferences.snap_to_grid);
    let check = reopened.begin_replacement(restored.revision).unwrap();
    assert_eq!(
        check.restored_revision(job).unwrap(),
        Some(restored.revision)
    );
    assert_eq!(check.restored_revision(Uuid::new_v4()).unwrap(), None);
}

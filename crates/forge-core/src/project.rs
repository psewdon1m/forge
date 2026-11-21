use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::Write,
    ops::Range,
    path::{Path, PathBuf},
    time::Duration,
};

use cap_std::{ambient_authority, fs::Dir};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AssetFormat, AssetPreview, AssetRef, Change, Content, DataLink, DataType, DirectoryChange,
    DirectoryListing, Error, GalleryItem, ImportItem, ImportProgress, ImportRequest, ImportResult,
    Node, Position, Result, Space, Viewport,
    assets::{AssetStore, MAX_BATCH_BYTES, MAX_FILES, source_name},
    data_links::{self, GALLERY, Gallery, gallery, is_image, readable_link, set_gallery},
    dataset::{self, Dataset},
    directory::{self, DIRECTORY_TYPE},
    model::validate_label,
    scheme,
    video::is_video,
};

mod analysis;
mod backup;
mod editor;
mod intelligent;
mod research;
mod sources;
pub use analysis::{
    AnalysisPhase, ComparisonRequest, ComparisonSide, MetadataRequest, MetadataSummary,
    PaletteRequest, PaletteStatus, PaletteSummary,
};
pub use backup::BackupInfo;
pub use backup::{
    PreparedUpdateBackup, RecoveredUpdateBackup, UpdateBackupInfo, UpdateBackupReceipt,
    UpdateBackupScope, UpdateProjectScope, open_update_backup, prepare_update_backup,
};
pub use backup::{
    SettingsBackupInfo, create_settings_backup, inspect_settings_backup, read_settings_backup,
};
pub use editor::{EditorExportRequest, EditorPreviewRequest};
pub use research::ResearchStatus;
use sources::LinkedCollection;
pub use sources::{LinkedFilePage, SourceFile};

const SCHEMA: u32 = 1;
const MAX_SPACE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    project_id: Uuid,
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_project_id: Option<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditRequest {
    pub operation_id: Uuid,
    pub base_revision: i64,
    pub change: Change,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceAssetRequest {
    pub operation_id: Uuid,
    pub base_revision: i64,
    pub node_id: Uuid,
    pub version_id: Uuid,
    pub source: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditTextAssetRequest {
    pub operation_id: Uuid,
    pub base_revision: i64,
    pub node_id: Uuid,
    pub version_id: Uuid,
    pub text: String,
}

struct AssetUpdateTarget {
    operation_id: Uuid,
    base_revision: i64,
    node_id: Uuid,
    version_id: Uuid,
}

enum AssetUpdate<'a> {
    File(&'a Path),
    Text(&'a str),
    ExternalDocument(&'a Path),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub space: Space,
    pub revision: i64,
    pub viewport: Viewport,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPage {
    pub source_revision: String,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub items: Vec<AssetRef>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedText {
    pub source_revision: String,
    pub text: String,
}

struct Navigation {
    undo: Option<i64>,
    redo: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionEntry {
    pub revision: i64,
    pub actor: String,
    pub reason: String,
    pub occurred_at: String,
    pub digest: String,
}

pub struct Project {
    connection: Connection,
    id: Uuid,
    source_project_id: Option<Uuid>,
    root: Dir,
    canonical_root: PathBuf,
    _lock: File,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistRecordPage {
    pub source_revision: String,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub groups: Vec<crate::ChecklistGroup>,
    pub rows: Vec<crate::ChecklistItem>,
}

impl Project {
    pub fn check_git_card(&self, node_id: Uuid) -> Result<()> {
        let (space, _, _) = self.read_head()?;
        if space.nodes.iter().any(|node| node.id == node_id && matches!(
            &node.content, Content::Portal { type_id, schema_version: 1, .. } if type_id == crate::git::TYPE_ID
        )) {
            Ok(())
        } else {
            Err(Error::Invalid("Open a Git card in this project"))
        }
    }

    pub fn directory_listing(&self, node_id: Uuid, folder: &[String]) -> Result<DirectoryListing> {
        self.directory_revision(node_id)?;
        directory::list(&self.root, folder)
    }

    pub fn change_directory(
        &self,
        node_id: Uuid,
        base_revision: i64,
        change: DirectoryChange,
    ) -> Result<()> {
        let current = self.directory_revision(node_id)?;
        if base_revision != current {
            return Err(Error::StaleRevision { current });
        }
        directory::change(&self.root, change)
    }

    fn directory_revision(&self, node_id: Uuid) -> Result<i64> {
        let (space, revision, _) = self.read_head()?;
        if space.nodes.iter().any(|node| node.id == node_id && matches!(
            &node.content, Content::Portal { type_id, schema_version: 1, .. } if type_id == DIRECTORY_TYPE
        )) {
            Ok(revision)
        } else {
            Err(Error::Invalid("Open a Directory card in this project"))
        }
    }

    pub fn create(root: &Path, title: String) -> Result<Self> {
        validate_label(&title)?;
        check_directory(root)?;
        if fs::read_dir(root)?.next().transpose()?.is_some() {
            return Err(Error::AlreadyExists);
        }
        let id = Uuid::new_v4();
        let staging = root.join(format!(".forge-create-{id}"));
        fs::create_dir(&staging)?;
        let result = (|| {
            let manifest = Manifest {
                format: "forge-project".into(),
                project_id: id,
                schema_version: SCHEMA,
                source_project_id: None,
            };
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join("project.json"))?;
            serde_json::to_writer_pretty(&mut file, &manifest)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            drop(file);
            let database = Connection::open(staging.join("workspace.sqlite"))?;
            database.execute_batch(include_str!("schema-v1.sql"))?;
            let state = Space {
                project_id: id,
                title,
                nodes: vec![],
                groups: vec![],
                links: vec![],
            };
            let snapshot = encode(&state)?;
            let viewport = encode(&Viewport::default())?;
            database.execute(
                "INSERT INTO head(id, revision, viewport) VALUES (1, 0, ?1)",
                [viewport],
            )?;
            database.execute(
                "INSERT INTO revisions(revision, operation_id, actor, reason, snapshot, digest)
                 VALUES (0, ?1, 'local-user', 'createProject', ?2, ?3)",
                params![Uuid::new_v4().to_string(), &snapshot, digest(&snapshot)],
            )?;
            database.close().map_err(|(_, error)| error)?;
            publish_new_project(root, &staging)?;
            Self::open(root)
        })();
        if result.is_err() && staging.exists() {
            // The stage was created by this call and only contains known project files.
            for name in [
                "workspace.sqlite-journal",
                "workspace.sqlite",
                "project.json",
            ] {
                let _ = fs::remove_file(staging.join(name));
            }
            let _ = fs::remove_dir(&staging);
        }
        result
    }

    pub fn open(root: &Path) -> Result<Self> {
        Self::open_expected(root, None)
    }

    pub fn open_expected(root: &Path, expected_project_id: Option<Uuid>) -> Result<Self> {
        check_directory(root)?;
        let metadata = root.join(".forge");
        check_directory(&metadata)?;
        let manifest_path = metadata.join("project.json");
        check_file(&manifest_path)?;
        if fs::metadata(&manifest_path)?.len() > 4096 {
            return Err(Error::Corrupt("Project manifest is unexpectedly large"));
        }
        let manifest: Manifest = serde_json::from_reader(File::open(manifest_path)?)?;
        if manifest.format != "forge-project" || manifest.project_id.is_nil() {
            return Err(Error::Corrupt("Invalid Forge project identity"));
        }
        if expected_project_id.is_some_and(|expected| expected != manifest.project_id) {
            return Err(Error::Invalid("This folder belongs to a different project"));
        }
        if manifest.schema_version != SCHEMA {
            return Err(Error::UnsupportedSchema(manifest.schema_version));
        }
        let lock_path = metadata.join("writer.lock");
        match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if !metadata.is_file() || is_link(&metadata) => {
                return Err(Error::Invalid("Project lock path must be an ordinary file"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(Error::Locked),
            Err(TryLockError::Error(error)) => return Err(Error::Io(error)),
        }
        let db_path = metadata.join("workspace.sqlite");
        check_file(&db_path)?;
        let connection = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(2))?;
        let application: i32 =
            connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
        if application != 0x464F5247 {
            return Err(Error::Corrupt("Database does not belong to Forge"));
        }
        let schema: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if schema != SCHEMA {
            return Err(Error::UnsupportedSchema(schema));
        }
        connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;",
        )?;
        let project = Self {
            connection,
            id: manifest.project_id,
            source_project_id: manifest.source_project_id,
            root: Dir::open_ambient_dir(root, ambient_authority())?,
            canonical_root: fs::canonicalize(root)?,
            _lock: lock,
        };
        let (space, _, _) = project.read_head()?;
        project
            .connection
            .execute_batch(include_str!("schema-navigation-v1.sql"))?;
        project
            .connection
            .execute_batch(include_str!("schema-assets-v1.sql"))?;
        project
            .connection
            .execute_batch(include_str!("schema-analyses-v1.sql"))?;
        validate_asset_refs(&project.connection, &space)?;
        let unfinished: bool = project.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM asset_intents)",
            [],
            |row| row.get(0),
        )?;
        if unfinished {
            AssetStore::open(&project.root, false)?.recover(&project.connection)?;
        }
        Ok(project)
    }

    pub fn verify_integrity(&self) -> Result<()> {
        let result: String =
            self.connection
                .pragma_query_value(None, "integrity_check", |row| row.get(0))?;
        if result != "ok" {
            return Err(Error::Corrupt("Project integrity check failed"));
        }
        Ok(())
    }

    pub fn view(&self) -> Result<ProjectView> {
        let (space, revision, viewport) = self.read_head()?;
        let navigation = navigation_for(&self.connection, revision)?;
        Ok(ProjectView {
            space,
            revision,
            viewport,
            can_undo: navigation.undo.is_some(),
            can_redo: navigation.redo.is_some(),
        })
    }

    fn read_head(&self) -> Result<(Space, i64, Viewport)> {
        let (revision, encoded): (i64, Vec<u8>) = self.connection.query_row(
            "SELECT revision, viewport FROM head WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let viewport: Viewport = decode(&encoded)?;
        viewport.validate()?;
        Ok((
            read_snapshot(&self.connection, self.id, revision)?,
            revision,
            viewport,
        ))
    }

    pub fn save_viewport(&self, viewport: Viewport) -> Result<()> {
        viewport.validate()?;
        self.connection.execute(
            "UPDATE head SET viewport = ?1 WHERE id=1",
            [encode(&viewport)?],
        )?;
        Ok(())
    }

    pub fn apply(&mut self, request: EditRequest) -> Result<i64> {
        self.apply_with_pdf_extractor(request, |_| {
            Err(Error::Link(
                "PDF_UNAVAILABLE",
                "PDF text extraction is unavailable",
            ))
        })
    }

    pub fn apply_with_pdf_extractor(
        &mut self,
        request: EditRequest,
        extract_pdf: crate::research::PdfExtractor,
    ) -> Result<i64> {
        if request.operation_id.is_nil() || request.base_revision < 0 {
            return Err(Error::Invalid("Invalid operation identity or revision"));
        }
        let fingerprint = digest(&encode(&request)?);
        let operation_id = request.operation_id.to_string();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if batch_replay(&tx, &operation_id, &fingerprint)?.is_some() {
            return Err(Error::Invalid("Operation ID already used for an import"));
        }
        let prior: Option<(i64, String)> = tx.query_row(
            "SELECT revision, request_digest FROM revisions WHERE operation_id=?1 AND request_digest IS NOT NULL",
            [&operation_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        if let Some((revision, previous)) = prior {
            return if previous == fingerprint {
                Ok(revision)
            } else {
                Err(Error::Invalid(
                    "Operation ID already used for another request",
                ))
            };
        }
        let head: i64 =
            tx.query_row("SELECT revision FROM head WHERE id=1", [], |row| row.get(0))?;
        if head != request.base_revision {
            return Err(Error::StaleRevision { current: head });
        }
        let revision = head.checked_add(1).ok_or(Error::Limit)?;
        let mut next_navigation = Navigation {
            undo: Some(head),
            redo: None,
        };
        let (state, reason) = match request.change {
            Change::RestoreRevision { revision } => {
                (read_snapshot(&tx, self.id, revision)?, "restoreRevision")
            }
            Change::Undo => {
                let target = navigation_for(&tx, head)?
                    .undo
                    .ok_or(Error::Invalid("Nothing to undo"))?;
                next_navigation.undo = navigation_for(&tx, target)?.undo;
                next_navigation.redo = Some(head);
                (read_snapshot(&tx, self.id, target)?, "undo")
            }
            Change::Redo => {
                let target = navigation_for(&tx, head)?
                    .redo
                    .ok_or(Error::Invalid("Nothing to redo"))?;
                next_navigation.redo = navigation_for(&tx, target)?.redo;
                (read_snapshot(&tx, self.id, target)?, "redo")
            }
            edit => {
                let reason = reason(&edit);
                let mut state = read_snapshot(&tx, self.id, head)?;
                let stamp = if matches!(edit, Change::EditChecklist { .. }) {
                    Some(crate::ChecklistCompletion {
                        occurred_at: tx.query_row(
                            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                            [],
                            |row| row.get(0),
                        )?,
                        revision,
                    })
                } else {
                    None
                };
                match edit {
                    Change::EditResearch { id, action } => {
                        research::apply(&tx, &self.root, &mut state, id, action, extract_pdf)?
                    }
                    Change::EditEditor {
                        id,
                        selection,
                        graph,
                    } => {
                        editor::apply(&tx, &mut state, id, selection, graph)?;
                        state.validate()?;
                    }
                    edit => state.apply(edit, stamp.as_ref())?,
                }
                (state, reason)
            }
        };
        validate_asset_refs(&tx, &state)?;
        append_revision(
            &tx,
            revision,
            &state,
            &operation_id,
            &fingerprint,
            reason,
            next_navigation,
        )?;
        tx.commit()?;
        Ok(revision)
    }

    pub fn asset_details(&self, node_id: Uuid, version_id: Uuid) -> Result<AssetRef> {
        let (space, _, _) = self.read_head()?;
        let Some(Content::Asset { asset }) = space
            .nodes
            .into_iter()
            .find(|node| node.id == node_id)
            .map(|node| node.content)
        else {
            return Err(Error::AssetUnavailable);
        };
        if asset.version_id != version_id {
            return Err(Error::AssetUnavailable);
        }
        let mut statement = self.connection.prepare(ASSET_METADATA_QUERY)?;
        validate_asset_ref(&mut statement, &asset)?;
        Ok(asset)
    }

    pub fn preview_asset(&self, node_id: Uuid, version_id: Uuid) -> Result<AssetPreview> {
        let asset = self.asset_details(node_id, version_id)?;
        AssetStore::open(&self.root, false)?.preview(&asset)
    }

    pub fn export_asset(&self, node_id: Uuid, version_id: Uuid, destination: &Path) -> Result<()> {
        let asset = self.asset_details(node_id, version_id)?;
        AssetStore::open(&self.root, false)?.export(&asset, destination)
    }

    pub fn read_asset_text(&self, node_id: Uuid, version_id: Uuid) -> Result<String> {
        let asset = self.asset_details(node_id, version_id)?;
        AssetStore::open(&self.root, false)?.read_text(&asset)
    }

    pub fn replace_asset(&mut self, request: ReplaceAssetRequest) -> Result<i64> {
        let fingerprint = digest(&encode(&request)?);
        self.update_asset(
            AssetUpdateTarget {
                operation_id: request.operation_id,
                base_revision: request.base_revision,
                node_id: request.node_id,
                version_id: request.version_id,
            },
            AssetUpdate::File(&request.source),
            &fingerprint,
        )
    }

    pub fn edit_text_asset(&mut self, request: EditTextAssetRequest) -> Result<i64> {
        let fingerprint = digest(&encode(&request)?);
        self.update_asset(
            AssetUpdateTarget {
                operation_id: request.operation_id,
                base_revision: request.base_revision,
                node_id: request.node_id,
                version_id: request.version_id,
            },
            AssetUpdate::Text(&request.text),
            &fingerprint,
        )
    }

    pub fn import_edited_document(&mut self, request: ReplaceAssetRequest) -> Result<i64> {
        let fingerprint = digest(&encode(&("editDocumentAsset", &request))?);
        self.update_asset(
            AssetUpdateTarget {
                operation_id: request.operation_id,
                base_revision: request.base_revision,
                node_id: request.node_id,
                version_id: request.version_id,
            },
            AssetUpdate::ExternalDocument(&request.source),
            &fingerprint,
        )
    }

    fn update_asset(
        &mut self,
        target: AssetUpdateTarget,
        update: AssetUpdate<'_>,
        fingerprint: &str,
    ) -> Result<i64> {
        if target.operation_id.is_nil() || target.base_revision < 0 {
            return Err(Error::Invalid("Invalid file update request"));
        }
        let operation_id = target.operation_id.to_string();
        if batch_replay(&self.connection, &operation_id, fingerprint)?.is_some() {
            return Err(Error::Invalid("Operation ID already used for an import"));
        }
        let prior: Option<(i64, String)> = self.connection.query_row(
            "SELECT revision, request_digest FROM revisions WHERE operation_id=?1 AND request_digest IS NOT NULL",
            [&operation_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((revision, previous)) = prior {
            return if previous == fingerprint {
                Ok(revision)
            } else {
                Err(Error::Invalid(
                    "Operation ID already used for another request",
                ))
            };
        }
        let (mut space, head, _) = self.read_head()?;
        if head != target.base_revision {
            return Err(Error::StaleRevision { current: head });
        }
        let node = space
            .nodes
            .iter_mut()
            .find(|node| node.id == target.node_id)
            .ok_or(Error::AssetUnavailable)?;
        let Content::Asset { asset: previous } = &node.content else {
            return Err(Error::AssetUnavailable);
        };
        if previous.version_id != target.version_id {
            return Err(Error::AssetUnavailable);
        }
        validate_asset_ref(
            &mut self.connection.prepare(ASSET_METADATA_QUERY)?,
            previous,
        )?;

        let store = AssetStore::open(&self.root, false)?;
        store.recover(&self.connection)?;
        let (asset, reason) = match update {
            AssetUpdate::File(source) => {
                let mut remaining = MAX_BATCH_BYTES;
                let asset =
                    store.prepare(&self.connection, source, &mut remaining, Some(previous))?;
                (asset, "replaceAsset")
            }
            AssetUpdate::Text(text) => {
                let asset = store.prepare_text(&self.connection, previous, text)?;
                (asset, "editTextAsset")
            }
            AssetUpdate::ExternalDocument(source) => {
                let asset = store.prepare_edited_document(&self.connection, source, previous)?;
                (asset, "editDocumentAsset")
            }
        };
        node.label.clone_from(&asset.name);
        node.content = Content::Asset {
            asset: asset.clone(),
        };
        let finish = (|| {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current: i64 =
                tx.query_row("SELECT revision FROM head WHERE id=1", [], |row| row.get(0))?;
            if current != head {
                return Err(Error::StaleRevision { current });
            }
            space.validate()?;
            record_asset_version(&tx, &asset)?;
            validate_asset_refs(&tx, &space)?;
            let revision = head.checked_add(1).ok_or(Error::Limit)?;
            append_revision(
                &tx,
                revision,
                &space,
                &operation_id,
                fingerprint,
                reason,
                Navigation {
                    undo: Some(head),
                    redo: None,
                },
            )?;
            tx.commit()?;
            Ok(revision)
        })();
        if finish.is_err() {
            store.recover(&self.connection)?;
        }
        finish
    }

    pub fn import_assets(&mut self, request: ImportRequest) -> Result<ImportResult> {
        self.import_assets_with_progress(request, |_| Ok(()))
    }

    pub fn import_assets_with_progress(
        &mut self,
        request: ImportRequest,
        mut observe: impl FnMut(ImportProgress) -> Result<()>,
    ) -> Result<ImportResult> {
        self.import_batch_with_progress(request, None, &mut observe)
    }

    pub fn import_batch_with_progress(
        &mut self,
        request: ImportRequest,
        gallery_id: Option<Uuid>,
        mut observe: impl FnMut(ImportProgress) -> Result<()>,
    ) -> Result<ImportResult> {
        if request.operation_id.is_nil()
            || request.base_revision < 0
            || request.paths.is_empty()
            || request.paths.len() > MAX_FILES
        {
            return Err(Error::Invalid("Select between 1 and 50 files for import"));
        }
        request.position.validate()?;
        let fingerprint = match gallery_id {
            Some(id) => digest(&encode(&("galleryImport", id, &request))?),
            None => digest(&encode(&request)?),
        };
        let operation_id = request.operation_id.to_string();
        if let Some(result) = batch_replay(&self.connection, &operation_id, &fingerprint)? {
            return Ok(result);
        }
        if self
            .connection
            .query_row(
                "SELECT 1 FROM revisions WHERE operation_id=?1",
                [&operation_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(Error::Invalid(
                "Operation ID already used for another request",
            ));
        }
        let (mut space, head, _) = self.read_head()?;
        if head != request.base_revision {
            return Err(Error::StaleRevision { current: head });
        }
        let mut collection = gallery_id
            .map(|id| {
                space
                    .nodes
                    .iter()
                    .find(|node| node.id == id)
                    .ok_or(Error::Invalid("Gallery is not in this project"))
                    .and_then(gallery)
            })
            .transpose()?;
        let store = AssetStore::open(&self.root, true)?;
        store.recover(&self.connection)?;
        let finish = (|| {
            let mut remaining = MAX_BATCH_BYTES;
            let mut items = Vec::new();
            let total_files = request.paths.len();
            for (index, source) in request.paths.into_iter().enumerate() {
                observe(ImportProgress::Copying {
                    file_index: index + 1,
                    total_files,
                    bytes: 0,
                    file_bytes: 0,
                })?;
                let position = Position {
                    x: request.position.x,
                    y: request.position.y + 150.0 * index as f64,
                };
                let result = (|| {
                    if collection.is_some() {
                        let format = AssetFormat::from_path(&source)?;
                        if !is_image(format) && !is_video(format) {
                            return Err(Error::Invalid(
                                "Gallery accepts PNG, JPEG, WebP, WebM and MP4",
                            ));
                        }
                    } else {
                        position.validate()?;
                    }
                    store.prepare_with_progress(
                        &self.connection,
                        &source,
                        &mut remaining,
                        None,
                        |bytes, file_bytes| {
                            observe(ImportProgress::Copying {
                                file_index: index + 1,
                                total_files,
                                bytes,
                                file_bytes,
                            })
                        },
                    )
                })();
                items.push(match result {
                    Ok(asset) => {
                        let node_id = if let Some(gallery) = collection.as_mut() {
                            gallery.items.push(GalleryItem {
                                asset_id: asset.asset_id,
                                version_id: asset.version_id,
                            });
                            None
                        } else {
                            let id = Uuid::new_v4();
                            space.nodes.push(Node {
                                id,
                                label: asset.name.clone(),
                                position,
                                content: Content::Asset {
                                    asset: asset.clone(),
                                },
                            });
                            Some(id)
                        };
                        ImportItem {
                            name: asset.name.clone(),
                            asset: Some(asset),
                            node_id,
                            error_code: None,
                            message: None,
                        }
                    }
                    Err(Error::ImportCanceled) => return Err(Error::ImportCanceled),
                    Err(error) => ImportItem {
                        name: source_name(&source).unwrap_or_else(|_| "Selected file".to_owned()),
                        asset: None,
                        node_id: None,
                        error_code: Some(error.code().to_owned()),
                        message: Some(error.to_string()),
                    },
                });
            }
            if let (Some(id), Some(gallery)) = (gallery_id, collection.as_ref()) {
                let node = space
                    .nodes
                    .iter_mut()
                    .find(|node| node.id == id)
                    .ok_or(Error::Invalid("Gallery is not in this project"))?;
                set_gallery(node, gallery)?;
            }
            observe(ImportProgress::Committing { total_files })?;
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current: i64 =
                tx.query_row("SELECT revision FROM head WHERE id=1", [], |row| row.get(0))?;
            if current != head {
                return Err(Error::StaleRevision { current });
            }
            let mut revision = head;
            if items.iter().any(|item| item.asset.is_some()) {
                space.validate()?;
                for entry in items.iter().filter_map(|item| item.asset.as_ref()) {
                    record_asset_version(&tx, entry)?;
                }
                validate_asset_refs(&tx, &space)?;
                revision = head.checked_add(1).ok_or(Error::Limit)?;
                append_revision(
                    &tx,
                    revision,
                    &space,
                    &operation_id,
                    &fingerprint,
                    if gallery_id.is_some() {
                        "importGallery"
                    } else {
                        "importAssets"
                    },
                    Navigation {
                        undo: Some(head),
                        redo: None,
                    },
                )?;
            }
            let response = ImportResult { revision, items };
            tx.execute(
                "INSERT INTO asset_import_batches(operation_id, request_digest, response) VALUES (?1, ?2, ?3)",
                params![operation_id, fingerprint, encode(&response)?],
            )?;
            tx.commit()?;
            Ok(response)
        })();
        if finish.is_err() {
            store.recover(&self.connection)?;
        }
        finish
    }

    pub fn gallery_page(
        &self,
        node_id: Uuid,
        revision: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<AssetPage> {
        let (space, _, _) = self.read_head()?;
        let node = space
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or(Error::Invalid("Gallery is not in this project"))?;
        let collection = gallery(node)?;
        asset_page(&self.connection, &collection, revision, offset, limit)
    }

    pub fn gallery_preview(
        &self,
        node_id: Uuid,
        source_revision: &str,
        version_id: Uuid,
    ) -> Result<AssetPreview> {
        let asset = self.gallery_member(node_id, source_revision, version_id)?;
        AssetStore::open(&self.root, false)?.preview(&asset)
    }

    pub fn export_gallery_video(
        &self,
        node_id: Uuid,
        source_revision: &str,
        version_id: Uuid,
        destination: &Path,
    ) -> Result<()> {
        let asset = self.gallery_member(node_id, source_revision, version_id)?;
        if !is_video(asset.format) {
            return Err(Error::Invalid("Choose a video from this Gallery"));
        }
        AssetStore::open(&self.root, false)?.export(&asset, destination)
    }

    fn gallery_member(
        &self,
        node_id: Uuid,
        source_revision: &str,
        version_id: Uuid,
    ) -> Result<AssetRef> {
        let (space, _, _) = self.read_head()?;
        let node = space
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or(Error::Invalid("Gallery is not in this project"))?;
        let collection = gallery(node)?;
        verify_source_revision(&collection, Some(source_revision))?;
        let item = collection
            .items
            .iter()
            .find(|item| item.version_id == version_id)
            .ok_or(Error::AssetUnavailable)?;
        gallery_asset(&mut self.connection.prepare(ASSET_METADATA_QUERY)?, item)
    }

    pub fn linked_assets(
        &self,
        target_id: Uuid,
        link_id: Uuid,
        revision: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<LinkedFilePage> {
        let (space, _, _) = self.read_head()?;
        let (source, link) = linked_source(&space, target_id, link_id)?;
        let collection = LinkedCollection::from_link(self, source, link)?;
        let source_revision = collection.revision();
        check_source_revision(&source_revision, revision)?;
        let total = collection.len();
        let end = page_bounds(offset, limit, total)?;
        Ok(LinkedFilePage {
            source_revision,
            total,
            next_offset: (end < total).then_some(end),
            items: collection.files(&self.connection, offset..end)?,
            unavailable_count: collection.unavailable_count(),
        })
    }

    pub fn linked_text(
        &self,
        target_id: Uuid,
        link_id: Uuid,
        expected: Option<&str>,
    ) -> Result<LinkedText> {
        let (space, _, _) = self.read_head()?;
        let (source, link) = linked_source(&space, target_id, link_id)?;
        if link.data_type != DataType::TextContent {
            return Err(Error::Link(
                "LINK_INCOMPATIBLE",
                "This link does not provide text",
            ));
        }
        let (source_revision, text) = match &source.content {
            Content::Asset { asset } => {
                let revision = asset.version_id.to_string();
                check_source_revision(&revision, expected)?;
                validate_asset_ref(&mut self.connection.prepare(ASSET_METADATA_QUERY)?, asset)?;
                let text = AssetStore::open(&self.root, false)?.read_text(asset)?;
                (revision, text)
            }
            content => {
                let text = data_links::inline_text(content)?.ok_or(Error::Link(
                    "SOURCE_NOT_FOUND",
                    "The linked text is unavailable",
                ))?;
                let revision = digest(text.as_bytes());
                check_source_revision(&revision, expected)?;
                (revision, text.into_owned())
            }
        };
        Ok(LinkedText {
            source_revision,
            text,
        })
    }

    pub fn checklist_completions(
        &self,
        node_id: Uuid,
        expected: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<ChecklistRecordPage> {
        let (space, _, _) = self.read_head()?;
        let node = space
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or(Error::Invalid("That checklist is no longer in Space"))?;
        let list = crate::checklist::Checklist::from_content(&node.content)?;
        let Content::Portal { payload, .. } = &node.content else {
            unreachable!()
        };
        let source_revision = digest(payload.as_bytes());
        check_source_revision(&source_revision, expected)?;
        let rows: Vec<_> = list.items.into_iter().filter(|item| item.done).collect();
        let total = rows.len();
        let end = page_bounds(offset, limit, total)?;
        Ok(ChecklistRecordPage {
            source_revision,
            total,
            next_offset: (end < total).then_some(end),
            groups: list.groups,
            rows: rows.into_iter().skip(offset).take(end - offset).collect(),
        })
    }

    pub fn dataset_page(&self, node_id: Uuid, query: &dataset::Query) -> Result<dataset::Page> {
        let (space, _, _) = self.read_head()?;
        let node = space
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or(Error::Invalid("That Dataset is no longer in Space"))?;
        let payload = Dataset::payload(&node.content)?;
        let revision = digest(payload.as_bytes());
        check_source_revision(&revision, query.source_revision.as_deref())?;
        Dataset::decode(payload)?.page(revision, query)
    }

    pub fn export_dataset(
        &self,
        node_id: Uuid,
        source_revision: &str,
        delimiter: dataset::Delimiter,
        destination: &Path,
    ) -> Result<()> {
        if !destination.is_absolute()
            || !destination
                .extension()
                .and_then(|part| part.to_str())
                .is_some_and(|part| part.eq_ignore_ascii_case(delimiter.extension()))
        {
            return Err(Error::Invalid(
                "Choose an export filename with the selected delimiter's extension",
            ));
        }
        let (space, _, _) = self.read_head()?;
        let node = space
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or(Error::Invalid("That Dataset is no longer in Space"))?;
        let payload = Dataset::payload(&node.content)?;
        check_source_revision(&digest(payload.as_bytes()), Some(source_revision))?;
        let data = Dataset::decode(payload)?;
        crate::assets::publish_export(destination, |file| data.export(delimiter, file))
    }

    pub fn scheme_graph(&self, node_id: Uuid, expected: Option<&str>) -> Result<scheme::GraphData> {
        let (space, _, _) = self.read_head()?;
        let document = load_scheme(&space, node_id)?;
        let hash = digest(&encode(&(&document.elements, &document.lines))?);
        check_source_revision(&hash, expected)?;
        Ok(scheme::GraphData {
            source_revision: hash,
            elements: document.elements,
            lines: document.lines,
        })
    }

    pub fn export_scheme(
        &self,
        node_id: Uuid,
        base_revision: i64,
        destination: &Path,
    ) -> Result<()> {
        if !destination.is_absolute()
            || !destination
                .extension()
                .and_then(|part| part.to_str())
                .is_some_and(|part| part.eq_ignore_ascii_case("json"))
        {
            return Err(Error::Invalid("Choose a JSON export filename"));
        }
        let (space, head, _) = self.read_head()?;
        if head != base_revision {
            return Err(Error::StaleRevision { current: head });
        }
        let bytes = load_scheme(&space, node_id)?.portable()?;
        crate::assets::publish_export(destination, |file| Ok(file.write_all(&bytes)?))
    }

    pub fn revisions(&self, before: Option<i64>, limit: u16) -> Result<Vec<RevisionEntry>> {
        if !(1..=200).contains(&limit) {
            return Err(Error::Invalid("History page size must be 1–200"));
        }
        let mut statement = self.connection.prepare(
            "SELECT revision, actor, reason, occurred_at, digest FROM revisions
             WHERE ?1 IS NULL OR revision < ?1 ORDER BY revision DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![before, limit], |row| {
            Ok(RevisionEntry {
                revision: row.get(0)?,
                actor: row.get(1)?,
                reason: row.get(2)?,
                occurred_at: row.get(3)?,
                digest: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

fn batch_replay(
    db: &Connection,
    operation_id: &str,
    fingerprint: &str,
) -> Result<Option<ImportResult>> {
    let prior: Option<(String, Vec<u8>)> = db
        .query_row(
            "SELECT request_digest, response FROM asset_import_batches WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match prior {
        Some((previous, response)) if previous == fingerprint => Ok(Some(decode(&response)?)),
        Some(_) => Err(Error::Invalid(
            "Operation ID already used for another request",
        )),
        None => Ok(None),
    }
}

const ASSET_METADATA_QUERY: &str = "SELECT metadata FROM asset_versions WHERE version_id=?1";

fn record_asset_version(db: &Connection, asset: &AssetRef) -> Result<()> {
    let version = asset.version_id.to_string();
    db.execute(
        "INSERT INTO asset_versions(version_id, metadata) VALUES (?1, ?2)",
        params![version, serde_json::to_string(asset)?],
    )?;
    db.execute("DELETE FROM asset_intents WHERE version_id=?1", [&version])?;
    Ok(())
}

fn load_scheme(space: &Space, node_id: Uuid) -> Result<scheme::Document> {
    let node = space
        .nodes
        .iter()
        .find(|node| node.id == node_id)
        .ok_or(Error::Invalid("That Scheme is no longer in Space"))?;
    scheme::Document::decode(scheme::Document::payload(&node.content)?)
}

fn validate_asset_refs(db: &Connection, space: &Space) -> Result<()> {
    let mut statement = db.prepare(ASSET_METADATA_QUERY)?;
    for node in &space.nodes {
        if let Content::Asset { asset } = &node.content {
            validate_asset_ref(&mut statement, asset)?;
        }
        if matches!(&node.content, Content::Portal { type_id, schema_version: 1, .. } if type_id == GALLERY)
        {
            for item in gallery(node)?.items {
                gallery_asset(&mut statement, &item)?;
            }
        }
        if matches!(&node.content, Content::Portal { type_id, schema_version: 1, .. } if type_id == crate::research::TYPE_ID)
        {
            let research = crate::research::Document::from_content(&node.content)?;
            for asset in research
                .sources
                .iter()
                .flat_map(|source| &source.versions)
                .filter_map(|version| version.material.asset())
            {
                validate_asset_ref(&mut statement, asset)?;
            }
        }
        if matches!(&node.content, Content::Portal { type_id, schema_version: 1, .. } if type_id == crate::editor::TYPE_ID)
        {
            let edit = crate::editor::Document::from_content(&node.content)?;
            if let Some(recipe) = &edit.recipe {
                validate_asset_ref(&mut statement, &recipe.source)?;
            }
            for export in &edit.exports {
                validate_asset_ref(&mut statement, &export.recipe.source)?;
                validate_asset_ref(&mut statement, &export.asset)?;
            }
        }
    }
    Ok(())
}

fn gallery_asset(statement: &mut rusqlite::Statement<'_>, item: &GalleryItem) -> Result<AssetRef> {
    let stored: Option<String> = statement
        .query_row([item.version_id.to_string()], |row| row.get(0))
        .optional()?;
    let asset: AssetRef = serde_json::from_str(stored.as_deref().ok_or(Error::AssetUnavailable)?)?;
    if asset.asset_id != item.asset_id
        || asset.version_id != item.version_id
        || (!is_image(asset.format) && !is_video(asset.format))
    {
        return Err(Error::Invalid(
            "Gallery references an invalid project media item",
        ));
    }
    asset.validate()?;
    Ok(asset)
}

fn linked_source(space: &Space, target_id: Uuid, link_id: Uuid) -> Result<(&Node, &DataLink)> {
    let unavailable = || Error::Link("SOURCE_NOT_FOUND", "The source link is unavailable");
    let link = space
        .links
        .iter()
        .find(|link| link.id == link_id && link.target.node_id == target_id)
        .ok_or_else(unavailable)?;
    let source = space
        .nodes
        .iter()
        .find(|node| node.id == link.source.node_id)
        .ok_or_else(unavailable)?;
    let target = space
        .nodes
        .iter()
        .find(|node| node.id == target_id)
        .ok_or_else(unavailable)?;
    if !readable_link(source, target, link) {
        return Err(unavailable());
    }
    Ok((source, link))
}

fn check_source_revision(current: &str, expected: Option<&str>) -> Result<()> {
    if expected.is_some_and(|expected| expected != current) {
        return Err(Error::Link(
            "SOURCE_CHANGED",
            "The source changed. Refresh to read its current version",
        ));
    }
    Ok(())
}

fn verify_source_revision(collection: &Gallery, expected: Option<&str>) -> Result<String> {
    let current = collection.revision();
    check_source_revision(&current, expected)?;
    Ok(current)
}

fn page_bounds(offset: usize, limit: usize, total: usize) -> Result<usize> {
    if limit == 0 || limit > 100 || offset > total {
        return Err(Error::Invalid("Invalid asset page bounds"));
    }
    Ok((offset + limit).min(total))
}

enum ManagedCollection<'a> {
    File(&'a AssetRef),
    Gallery {
        collection: Gallery,
        revision: String,
        skipped_videos: usize,
    },
}

impl<'a> ManagedCollection<'a> {
    fn from_link(db: &Connection, node: &'a Node, link: &DataLink) -> Result<Self> {
        if !matches!(
            link.data_type,
            DataType::FileCollection | DataType::ImageCollection
        ) {
            return Err(Error::Link(
                "LINK_INCOMPATIBLE",
                "This source does not provide an asset collection",
            ));
        }
        match &node.content {
            Content::Asset { asset } => Ok(Self::File(asset)),
            _ => {
                let mut collection = gallery(node).map_err(|_| {
                    Error::Link("SOURCE_NOT_FOUND", "The collection provider is unavailable")
                })?;
                let revision = collection.revision();
                let mut skipped_videos = 0;
                if link.data_type == DataType::ImageCollection {
                    let mut statement = db.prepare(ASSET_METADATA_QUERY)?;
                    let mut images = Vec::with_capacity(collection.items.len());
                    for item in collection.items {
                        let asset = gallery_asset(&mut statement, &item)?;
                        if is_video(asset.format) {
                            skipped_videos += 1;
                        } else {
                            images.push(item);
                        }
                    }
                    collection.items = images;
                }
                Ok(Self::Gallery {
                    collection,
                    revision,
                    skipped_videos,
                })
            }
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::File(_) => 1,
            Self::Gallery { collection, .. } => collection.items.len(),
        }
    }

    fn revision(&self) -> String {
        match self {
            Self::File(asset) => Gallery {
                items: vec![GalleryItem {
                    asset_id: asset.asset_id,
                    version_id: asset.version_id,
                }],
            }
            .revision(),
            Self::Gallery { revision, .. } => revision.clone(),
        }
    }

    fn skipped_videos(&self) -> usize {
        match self {
            Self::File(_) => 0,
            Self::Gallery { skipped_videos, .. } => *skipped_videos,
        }
    }

    fn assets(&self, db: &Connection, range: Range<usize>) -> Result<Vec<AssetRef>> {
        let mut statement = db.prepare(ASSET_METADATA_QUERY)?;
        match self {
            Self::File(asset) => {
                validate_asset_ref(&mut statement, asset)?;
                Ok(if range.is_empty() {
                    vec![]
                } else {
                    vec![(*asset).clone()]
                })
            }
            Self::Gallery { collection, .. } => collection.items[range]
                .iter()
                .map(|item| gallery_asset(&mut statement, item))
                .collect(),
        }
    }

    fn version(&self, db: &Connection, version_id: Uuid) -> Result<Option<AssetRef>> {
        match self {
            Self::File(asset) if asset.version_id == version_id => {
                validate_asset_ref(&mut db.prepare(ASSET_METADATA_QUERY)?, asset)?;
                Ok(Some((*asset).clone()))
            }
            Self::File(_) => Ok(None),
            Self::Gallery { collection, .. } => collection
                .items
                .iter()
                .find(|item| item.version_id == version_id)
                .map(|item| gallery_asset(&mut db.prepare(ASSET_METADATA_QUERY)?, item))
                .transpose(),
        }
    }
}

fn asset_page(
    db: &Connection,
    gallery: &Gallery,
    expected: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<AssetPage> {
    let source_revision = verify_source_revision(gallery, expected)?;
    let total = gallery.items.len();
    let end = page_bounds(offset, limit, total)?;
    let mut statement = db.prepare(ASSET_METADATA_QUERY)?;
    let items = gallery.items[offset..end]
        .iter()
        .map(|item| gallery_asset(&mut statement, item))
        .collect::<Result<_>>()?;
    Ok(AssetPage {
        source_revision,
        total,
        next_offset: (end < total).then_some(end),
        items,
    })
}

fn validate_asset_ref(statement: &mut rusqlite::Statement<'_>, asset: &AssetRef) -> Result<()> {
    let data: Option<String> = statement
        .query_row([asset.version_id.to_string()], |row| row.get(0))
        .optional()?;
    let recorded: Option<AssetRef> = data.as_deref().map(serde_json::from_str).transpose()?;
    if recorded.as_ref() != Some(asset) {
        return Err(Error::Invalid(
            "This asset version is not part of the project",
        ));
    }
    Ok(())
}

fn append_revision(
    db: &Connection,
    revision: i64,
    state: &Space,
    operation_id: &str,
    fingerprint: &str,
    reason: &str,
    navigation: Navigation,
) -> Result<()> {
    let snapshot = encode(state)?;
    let hash = digest(&snapshot);
    db.execute(
        "INSERT INTO revisions(revision, operation_id, actor, reason, snapshot, digest, request_digest)
         VALUES (?1, ?2, 'local-user', ?3, ?4, ?5, ?6)",
        params![revision, operation_id, reason, snapshot, hash, fingerprint],
    )?;
    db.execute(
        "INSERT INTO revision_navigation(revision, undo_revision, redo_revision) VALUES (?1, ?2, ?3)",
        params![revision, navigation.undo, navigation.redo],
    )?;
    db.execute("UPDATE head SET revision=?1 WHERE id=1", [revision])?;
    Ok(())
}

fn navigation_for(connection: &Connection, revision: i64) -> Result<Navigation> {
    let value = connection
        .query_row(
            "SELECT undo_revision, redo_revision FROM revision_navigation WHERE revision=?1",
            [revision],
            |row| {
                Ok(Navigation {
                    undo: row.get(0)?,
                    redo: row.get(1)?,
                })
            },
        )
        .optional()?;
    // Early v1 projects recorded only linear edits. Those immutable snapshots remain valid.
    let value = value.unwrap_or(Navigation {
        undo: (revision > 0).then_some(revision - 1),
        redo: None,
    });
    if [value.undo, value.redo]
        .into_iter()
        .flatten()
        .any(|target| target < 0 || target >= revision)
    {
        return Err(Error::Corrupt("Invalid revision navigation"));
    }
    Ok(value)
}

fn reason(edit: &Change) -> &'static str {
    match edit {
        Change::Add { .. } => "add",
        Change::Move { .. } => "move",
        Change::MoveSelection { .. } => "moveSelection",
        Change::RenameProject { .. } => "renameProject",
        Change::RenameNode { .. } => "renameNode",
        Change::EditNote { .. } => "editNote",
        Change::EditChecklist { .. } => "editChecklist",
        Change::ImportDataset { .. } => "importDataset",
        Change::EditDatasetCell { .. } => "editDatasetCell",
        Change::EditScheme { .. } => "editScheme",
        Change::EditSite { .. } => "editSite",
        Change::EditResearch { .. } => "editResearch",
        Change::EditEditor { .. } => "editEditor",
        Change::SaveIntelligentResult { .. } => "saveIntelligentResult",
        Change::EditGallery { .. } => "editGallery",
        Change::Connect { .. } => "connect",
        Change::Disconnect { .. } => "disconnect",
        Change::ArchiveNode { .. } => "archiveNode",
        Change::ArchiveSelection { .. } => "archiveSelection",
        Change::GroupSelection { .. } => "groupSelection",
        Change::Ungroup { .. } => "ungroup",
        Change::Paste { .. } => "paste",
        Change::RestoreRevision { .. } => "restoreRevision",
        Change::Undo => "undo",
        Change::Redo => "redo",
    }
}

fn publish_new_project(root: &Path, staging: &PathBuf) -> Result<()> {
    for entry in fs::read_dir(root)? {
        if entry?.path() != *staging {
            return Err(Error::AlreadyExists);
        }
    }
    fs::rename(staging, root.join(".forge"))?;
    Ok(())
}

fn read_snapshot(connection: &Connection, project_id: Uuid, revision: i64) -> Result<Space> {
    let stored: Option<(Vec<u8>, String)> = connection
        .query_row(
            "SELECT snapshot, digest FROM revisions WHERE revision=?1 AND length(snapshot) <= ?2",
            params![revision, MAX_SPACE_BYTES as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (encoded, hash) = stored.ok_or(Error::Corrupt("Missing or oversized revision"))?;
    if digest(&encoded) != hash {
        return Err(Error::Corrupt("Project revision checksum mismatch"));
    }
    let snapshot: Space = decode(&encoded)?;
    if snapshot.project_id != project_id {
        return Err(Error::Corrupt("Revision belongs to another project"));
    }
    snapshot.validate()?;
    Ok(snapshot)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_SPACE_BYTES {
        return Err(Error::Limit);
    }
    Ok(bytes)
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if bytes.len() > MAX_SPACE_BYTES {
        return Err(Error::Limit);
    }
    Ok(serde_json::from_slice(bytes)?)
}

fn check_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(Error::Invalid("Project path must be an ordinary directory"));
    }
    Ok(())
}

fn check_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(Error::Invalid("Project metadata must be an ordinary file"));
    }
    Ok(())
}

pub(crate) fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

use std::{
    collections::{BTreeMap, HashSet},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
};

use zip::{CompressionMethod, ZipArchive, ZipWriter, result::ZipResult, write::SimpleFileOptions};

use super::*;

mod files;
mod records;
mod settings;
mod update;

pub use settings::{
    SettingsBackupInfo, create_settings_backup, inspect_settings_backup, read_settings_backup,
};
pub use update::{
    PreparedUpdateBackup, RecoveredUpdateBackup, UpdateBackupInfo, UpdateBackupReceipt,
    UpdateBackupScope, UpdateProjectScope, open_update_backup, prepare_update_backup,
};

const FORMAT: &str = "forge-project-backup";
const VERSION: u32 = 1;
const PROJECT: &str = "data/project.json";
const FOLDERS: &str = "data/folders.jsonl";
const MANIFEST: &str = "manifest.json";
const MAX_ZIP: u64 = 4 * 1024 * 1024 * 1024;
const MAX_RAW: u64 = 8 * 1024 * 1024 * 1024;
const MAX_MEMBERS: usize = 10_000;
const MAX_MANIFEST: u64 = 12 * 1024 * 1024;
const FIXED_MEMBERS: usize = 3 + records::TABLES.len();
const PROJECT_LIMITS: ArchiveLimits = ArchiveLimits {
    zip: MAX_ZIP,
    unpacked: MAX_RAW,
    manifest: MAX_MANIFEST,
    entries: FIXED_MEMBERS..=MAX_MEMBERS,
};

struct ArchiveLimits {
    zip: u64,
    unpacked: u64,
    manifest: u64,
    entries: std::ops::RangeInclusive<usize>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveManifest {
    format: String,
    schema_version: u32,
    source_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_project_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_schema: Option<u32>,
    scope: String,
    restore_mode: String,
    created_at: String,
    excluded_entries: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    update: Option<update::RecoveryPoint>,
    #[serde(deserialize_with = "unique_members")]
    members: BTreeMap<String, Member>,
}

fn unique_members<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> std::result::Result<BTreeMap<String, Member>, D::Error> {
    use serde::de::{Error as _, MapAccess, Visitor};
    struct Unique;
    impl<'de> Visitor<'de> for Unique {
        type Value = BTreeMap<String, Member>;
        fn expecting(&self, format: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            format.write_str("unique backup members")
        }
        fn visit_map<M: MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut members = BTreeMap::new();
            while let Some((key, value)) = map.next_entry()? {
                if members.insert(key, value).is_some() {
                    return Err(M::Error::custom("duplicate backup member"));
                }
            }
            Ok(members)
        }
    }
    input.deserialize_map(Unique)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Member {
    bytes: u64,
    sha256: String,
    records: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectData {
    project_id: Uuid,
    title: String,
    revision: i64,
    viewport: Viewport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub source_project_id: Uuid,
    pub title: String,
    pub revision: i64,
    pub source_version: String,
    pub created_at: String,
    pub archive_bytes: u64,
    pub unpacked_bytes: u64,
    pub archive_sha256: String,
    pub files: usize,
    pub revisions: u64,
    pub analyses: u64,
    pub excluded_entries: usize,
}

struct Inspected {
    zip: ZipArchive<File>,
    payload: ProjectPayload,
    info: BackupInfo,
}

struct ProjectPayload {
    members: BTreeMap<String, Member>,
    project: ProjectData,
    folders: Vec<String>,
}

impl ProjectPayload {
    fn restore_bytes(&self) -> u64 {
        self.members
            .iter()
            .fold(4 * 1024 * 1024, |bytes, (name, member)| {
                bytes.saturating_add(member.bytes.saturating_mul(if name.starts_with("files/") {
                    1
                } else {
                    2
                }))
            })
    }
}

struct ProjectSnapshot<'a> {
    project: &'a Project,
    read: rusqlite::Transaction<'a>,
    data: ProjectData,
    assets: Vec<AssetRef>,
    tree: files::Inventory,
    raw: u64,
}

impl<'a> ProjectSnapshot<'a> {
    fn capture(project_ref: &'a Project, base_revision: i64, byte_limit: u64) -> Result<Self> {
        let read = project_ref.connection.unchecked_transaction()?;
        let (space, revision, viewport) = project_ref.read_head()?;
        if revision != base_revision {
            return Err(Error::StaleRevision { current: revision });
        }
        let pending: bool =
            read.query_row("SELECT EXISTS(SELECT 1 FROM asset_intents)", [], |row| {
                row.get(0)
            })?;
        if pending {
            return Err(Error::Link(
                "PROJECT_BUSY",
                "Complete the pending project write before exporting",
            ));
        }
        let project = ProjectData {
            project_id: space.project_id,
            title: space.title,
            revision,
            viewport,
        };
        records::health(&read, project.project_id, &project)?;
        let assets = records::assets(&read)?;
        let tree = files::inventory(&project_ref.root, &assets)?;
        let raw = tree.files.iter().try_fold(0u64, |sum, file| {
            sum.checked_add(file.bytes)
                .filter(|sum| *sum <= byte_limit)
                .ok_or_else(|| archive_limit("Project files exceed the ZIP storage budget"))
        })?;
        Ok(Self {
            project: project_ref,
            read,
            data: project,
            assets,
            tree,
            raw,
        })
    }

    fn write<W: Write + Seek>(&self, builder: &mut Builder<'_, W>, prefix: &str) -> Result<()> {
        let expected = self
            .assets
            .iter()
            .map(|asset| (format!("assets/{}", files::blob_name(asset)), asset))
            .collect::<BTreeMap<_, _>>();
        builder.write(&format!("{prefix}{PROJECT}"), |writer| {
            serde_json::to_writer(writer, &self.data)?;
            Ok(None)
        })?;
        for table in records::TABLES {
            builder.write(&format!("{prefix}{}", table.name), |writer| {
                records::dump(&self.read, table, writer).map(Some)
            })?;
        }
        builder.write(&format!("{prefix}{FOLDERS}"), |writer| {
            for folder in &self.tree.directories {
                serde_json::to_writer(&mut *writer, folder)?;
                writer.write_all(b"\n")?;
            }
            Ok(Some(self.tree.directories.len() as u64))
        })?;
        for file in &self.tree.files {
            let name = format!("{prefix}files/{}", file.path);
            let member = builder.write(&name, |writer| {
                files::read_member(&self.project.root, file, writer)?;
                Ok(None)
            })?;
            if expected
                .get(&file.path)
                .is_some_and(|asset| asset.sha256 != member.sha256)
            {
                return Err(Error::AssetIntegrity);
            }
        }
        Ok(())
    }

    fn verify_tree(&self) -> Result<()> {
        if files::inventory(&self.project.root, &self.assets)? != self.tree {
            return Err(workspace_changed());
        }
        Ok(())
    }
}

impl Project {
    pub fn create_backup(&self, destination: &Path, base_revision: i64) -> Result<BackupInfo> {
        let destination = files::absolute_destination(destination)?;
        if !destination
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
        {
            return Err(boundary("Choose a .zip destination"));
        }
        if path_within(&destination, &self.canonical_root) {
            return Err(boundary("Save the archive outside the project folder"));
        }
        if destination.symlink_metadata().is_ok() {
            return Err(Error::ExportExists);
        }
        let parent = destination.parent().expect("checked destination");
        let snapshot = ProjectSnapshot::capture(self, base_revision, MAX_ZIP)?;
        files::ensure_space(parent, snapshot.raw.saturating_add(1024 * 1024))?;
        let scratch = files::Scratch::create(parent)?;
        let draft = scratch.path().join("archive.zip");
        let mut zip = ZipWriter::new(
            OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&draft)?,
        );
        let created_at =
            snapshot
                .read
                .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
                    row.get(0)
                })?;
        let mut builder = Builder {
            zip: &mut zip,
            bytes: 0,
            limit: MAX_ZIP,
            members: BTreeMap::new(),
        };
        snapshot.write(&mut builder, "")?;
        snapshot.verify_tree()?;
        let manifest = ArchiveManifest {
            format: FORMAT.into(),
            schema_version: VERSION,
            source_version: env!("CARGO_PKG_VERSION").into(),
            source_project_id: Some(self.id),
            project_schema: Some(SCHEMA),
            scope: "project".into(),
            restore_mode: "copy".into(),
            created_at,
            excluded_entries: snapshot.tree.excluded,
            update: None,
            members: builder.members,
        };
        write_manifest(&mut zip, &manifest, MAX_MANIFEST)?;
        let file = zip_result(zip.finish())?;
        file.sync_all()?;
        drop(file);
        snapshot.read.commit()?;
        let inspected = inspect(&draft)?;
        drop(inspected.zip);
        files::publish(&draft, &destination)?;
        Ok(inspected.info)
    }

    pub fn inspect_backup(path: &Path) -> Result<BackupInfo> {
        Ok(inspect(path)?.info)
    }

    pub fn restore_backup(
        path: &Path,
        destination: &Path,
        expected_sha256: &str,
    ) -> Result<ProjectView> {
        let destination = files::absolute_destination(destination)?;
        if destination.symlink_metadata().is_ok() {
            return Err(Error::ExportExists);
        }
        let parent = destination.parent().expect("checked destination");
        if parent.ancestors().any(|folder| {
            folder
                .join(".forge/project.json")
                .symlink_metadata()
                .is_ok()
        }) {
            return Err(boundary(
                "Choose a parent outside an existing Forge project",
            ));
        }
        let mut inspected = inspect(path)?;
        if inspected.info.archive_sha256 != expected_sha256 {
            return Err(Error::Link(
                "BACKUP_CHANGED",
                "The archive differs from the inspected file",
            ));
        }
        files::ensure_space(parent, inspected.payload.restore_bytes())?;
        let scratch = files::Scratch::create(parent)?;
        let view = materialize_project(
            &mut inspected.zip,
            &inspected.payload,
            "",
            scratch.path(),
            Uuid::new_v4(),
            Some(inspected.payload.project.project_id),
        )?;
        drop(inspected.zip);
        files::publish(scratch.path(), &destination)?;
        scratch.release();
        Ok(view)
    }
}

fn materialize_project<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    payload: &ProjectPayload,
    prefix: &str,
    root: &Path,
    project_id: Uuid,
    source_project_id: Option<Uuid>,
) -> Result<ProjectView> {
    let metadata = root.join(".forge");
    fs::create_dir(&metadata)?;
    let db_path = metadata.join("workspace.sqlite");
    let mut db = Connection::open(&db_path)?;
    db.execute_batch(
        "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;",
    )?;
    db.execute_batch(include_str!("../schema-v1.sql"))?;
    db.execute_batch(include_str!("../schema-navigation-v1.sql"))?;
    db.execute_batch(include_str!("../schema-assets-v1.sql"))?;
    db.execute_batch(include_str!("../schema-analyses-v1.sql"))?;
    let transaction = db.transaction()?;
    for table in records::TABLES {
        let expected = &payload.members[table.name];
        let input = zip_result(zip.by_name(&format!("{prefix}{}", table.name)))?;
        let mut measured = MeasureRead::new(input, expected.bytes);
        let count = records::lines(&mut measured, |line| {
            records::restore_record(
                &transaction,
                table,
                line,
                payload.project.project_id,
                project_id,
            )
        })?;
        measured.finish(expected)?;
        if Some(count) != expected.records {
            return Err(invalid_archive(
                "Logical record count differs from the manifest",
            ));
        }
    }
    transaction.execute(
        "INSERT INTO head VALUES(1,?1,?2)",
        params![payload.project.revision, encode(&payload.project.viewport)?],
    )?;
    let assets = records::assets(&transaction)?;
    verify_registered_members(&assets, &payload.members)?;
    transaction.commit()?;
    db.close().map_err(|(_, error)| error)?;

    for folder in &payload.folders {
        fs::create_dir(root.join(folder))?;
    }
    if !assets.is_empty() {
        fs::create_dir(root.join("assets"))?;
        fs::create_dir(metadata.join("staging"))?;
    }
    for (name, expected) in &payload.members {
        let Some(path) = name.strip_prefix("files/") else {
            continue;
        };
        let output = root.join(path);
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        let input = zip_result(zip.by_name(&format!("{prefix}{name}")))?;
        let mut measured = MeasureRead::new(input, expected.bytes);
        io::copy(&mut measured, &mut target)?;
        measured.finish(expected)?;
        target.sync_all()?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(metadata.join("project.json"))?;
    serde_json::to_writer(
        &mut file,
        &Manifest {
            format: "forge-project".into(),
            project_id,
            schema_version: SCHEMA,
            source_project_id,
        },
    )?;
    file.sync_all()?;
    drop(file);
    let db = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")?;
    let space = records::health(&db, project_id, &payload.project)?;
    let revision = payload.project.revision;
    let navigation = navigation_for(&db, revision)?;
    db.close().map_err(|(_, error)| error)?;
    Ok(ProjectView {
        space,
        revision,
        viewport: payload.project.viewport,
        can_undo: navigation.undo.is_some(),
        can_redo: navigation.redo.is_some(),
    })
}

fn verify_registered_members(
    assets: &[AssetRef],
    members: &BTreeMap<String, Member>,
) -> Result<()> {
    let registered_count = members
        .keys()
        .filter(|name| name.starts_with("files/assets/"))
        .count();
    if registered_count != assets.len() {
        return Err(invalid_archive("Registered files and asset members differ"));
    }
    for asset in assets {
        let name = format!("files/assets/{}", files::blob_name(asset));
        if !members
            .get(&name)
            .is_some_and(|member| member.bytes == asset.bytes && member.sha256 == asset.sha256)
        {
            return Err(invalid_archive(
                "An asset member differs from its registered version",
            ));
        }
    }
    Ok(())
}

fn path_within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        Path::new(&path.to_string_lossy().to_uppercase())
            .starts_with(Path::new(&root.to_string_lossy().to_uppercase()))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

struct Envelope<R> {
    zip: ZipArchive<R>,
    manifest: ArchiveManifest,
    archive_bytes: u64,
    unpacked: u64,
    archive_sha256: String,
}

fn inspect_envelope<R: Read + Seek>(
    mut file: R,
    archive_bytes: u64,
    limits: ArchiveLimits,
    allowed_name: impl Fn(&str) -> bool,
) -> Result<Envelope<R>> {
    if archive_bytes > limits.zip {
        return Err(archive_limit("Archive exceeds its ZIP size limit"));
    }
    let count = validate_directory_trailer(&mut file, archive_bytes, limits.entries)?;
    let mut hash = DigestWriter::new(io::sink(), limits.zip);
    file.rewind()?;
    io::copy(&mut file, &mut hash)?;
    let archive_sha256 = hash.finish(None).sha256;
    file.rewind()?;
    let mut zip = zip_result(ZipArchive::new(file))?;
    if zip.offset() != 0
        || zip.len() != count
        || zip.has_duplicate_names()
        || zip_result(zip.has_overlapping_entries())?
    {
        return Err(invalid_archive(
            "Archive contains duplicate or overlapping ZIP entries",
        ));
    }
    let mut names = HashSet::new();
    let mut unpacked = 0u64;
    for index in 0..zip.len() {
        let entry = zip_result(zip.by_index(index))?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| invalid_archive("Archive member name is not UTF-8"))?;
        if !allowed_name(name)
            || !names.insert(name.to_uppercase())
            || !entry.is_file()
            || entry.encrypted()
            || entry.is_symlink()
            || !matches!(
                entry.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
            || (entry.compression() == CompressionMethod::Stored
                && entry.compressed_size() != entry.size())
        {
            return Err(invalid_archive(
                "ZIP contains an unapproved path, file type or compression",
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .filter(|total| *total <= limits.unpacked)
            .ok_or_else(|| archive_limit("Archive exceeds its uncompressed size limit"))?;
        if entry.size() > entry.compressed_size().saturating_mul(200) {
            return Err(archive_limit(
                "Archive member exceeds the 200:1 expansion limit",
            ));
        }
    }
    let manifest: ArchiveManifest = {
        let item = zip_result(zip.by_name(MANIFEST))?;
        if item.size() > limits.manifest {
            return Err(archive_limit("Archive manifest exceeds its size limit"));
        }
        let declared_size = item.size();
        let mut contents = Vec::new();
        item.take(declared_size + 1).read_to_end(&mut contents)?;
        if contents.len() as u64 != declared_size {
            return Err(invalid_archive(
                "Archive manifest size differs from its ZIP record",
            ));
        }
        serde_json::from_slice(&contents)
            .map_err(|_| invalid_archive("Cannot read the backup manifest"))?
    };
    if manifest.format != FORMAT
        || manifest.created_at.len() > 40
        || manifest.source_version.len() > 64
    {
        return Err(invalid_archive("Archive has an unsupported identity"));
    }
    if manifest.schema_version != VERSION {
        return Err(Error::UnsupportedSchema(manifest.schema_version));
    }
    if manifest.members.len() + 1 != count {
        return Err(invalid_archive("Archive members differ from the manifest"));
    }
    Ok(Envelope {
        zip,
        manifest,
        archive_bytes,
        unpacked,
        archive_sha256,
    })
}

fn inspect(path: &Path) -> Result<Inspected> {
    let file = files::open_archive(path)?;
    let bytes = file.metadata()?.len();
    let Envelope {
        mut zip,
        manifest,
        archive_bytes,
        unpacked,
        archive_sha256,
    } = inspect_envelope(file, bytes, PROJECT_LIMITS, allowed_name)?;
    let source_project_id = manifest
        .source_project_id
        .filter(|id| !id.is_nil())
        .ok_or_else(|| invalid_archive("Project archive source identity is missing"))?;
    if manifest.scope != "project" || manifest.restore_mode != "copy" || manifest.update.is_some() {
        return Err(invalid_archive("Archive has an unsupported project scope"));
    }
    let project_schema = manifest
        .project_schema
        .ok_or_else(|| invalid_archive("Project schema is missing"))?;
    if project_schema != SCHEMA {
        return Err(Error::UnsupportedSchema(project_schema));
    }
    let payload = inspect_project(&mut zip, "", manifest.members, source_project_id)?;
    let project = &payload.project;
    let info = BackupInfo {
        source_project_id: project.project_id,
        title: project.title.clone(),
        revision: project.revision,
        source_version: manifest.source_version.clone(),
        created_at: manifest.created_at.clone(),
        archive_bytes,
        unpacked_bytes: unpacked,
        archive_sha256,
        files: payload
            .members
            .keys()
            .filter(|name| name.starts_with("files/"))
            .count(),
        revisions: payload.members["history/revisions.jsonl"]
            .records
            .unwrap_or_default(),
        analyses: payload.members["data/analyses.jsonl"]
            .records
            .unwrap_or_default(),
        excluded_entries: manifest.excluded_entries,
    };
    Ok(Inspected { zip, payload, info })
}

fn inspect_project<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    prefix: &str,
    members: BTreeMap<String, Member>,
    source_project_id: Uuid,
) -> Result<ProjectPayload> {
    if !members.contains_key(PROJECT)
        || !members.contains_key(FOLDERS)
        || records::TABLES
            .iter()
            .any(|table| !members.contains_key(table.name))
    {
        return Err(invalid_archive(
            "Archive members differ from the project scope",
        ));
    }
    let mut folders = Vec::new();
    let mut project = None;
    for (name, member) in &members {
        if !allowed_name(name) || name == MANIFEST || !valid_hash(&member.sha256) {
            return Err(invalid_archive("Manifest includes an unapproved member"));
        }
        let item = zip_result(zip.by_name(&format!("{prefix}{name}")))?;
        if item.size() != member.bytes {
            return Err(invalid_archive(
                "Archive member size differs from the manifest",
            ));
        }
        let mut checked = MeasureRead::new(item, member.bytes);
        let record_count = if name == PROJECT {
            if member.bytes > 8192 {
                return Err(archive_limit("Project header is too large"));
            }
            project = Some(
                serde_json::from_reader::<_, ProjectData>(&mut checked)
                    .map_err(|_| invalid_archive("The project header is invalid"))?,
            );
            None
        } else if name == FOLDERS {
            Some(records::lines(&mut checked, |line| {
                if folders.len() >= MAX_MEMBERS || line.len() > 16_384 {
                    return Err(archive_limit("Archive folder list exceeds its limit"));
                }
                let folder: String = serde_json::from_slice(line)?;
                if !files::working_path(&folder) {
                    return Err(boundary("Archive contains an unsafe folder name"));
                }
                folders.push(folder);
                Ok(())
            })?)
        } else if let Some(table) = records::TABLES.iter().find(|table| table.name == name) {
            Some(records::lines(&mut checked, |line| {
                records::validate_record(table, line, source_project_id, None)?;
                Ok(())
            })?)
        } else {
            io::copy(&mut checked, &mut io::sink())?;
            None
        };
        checked.finish(member)?;
        if record_count != member.records {
            return Err(invalid_archive(
                "Logical record count differs from the manifest",
            ));
        }
    }
    let project = project.ok_or_else(|| invalid_archive("Archive has no project header"))?;
    if project.project_id != source_project_id || project.revision < 0 {
        return Err(invalid_archive("Project header identity is invalid"));
    }
    validate_label(&project.title)?;
    project.viewport.validate()?;
    folders.sort();
    validate_paths(&folders, &members)?;
    let revisions = members["history/revisions.jsonl"]
        .records
        .unwrap_or_default();
    if i64::try_from(revisions).ok() != project.revision.checked_add(1) {
        return Err(invalid_archive(
            "Expected a complete history through the recorded revision",
        ));
    }
    Ok(ProjectPayload {
        members,
        project,
        folders,
    })
}

fn validate_paths(folders: &[String], members: &BTreeMap<String, Member>) -> Result<()> {
    let dirs = folders.iter().map(String::as_str).collect::<HashSet<_>>();
    let paths = members
        .keys()
        .filter_map(|name| name.strip_prefix("files/"));
    if folders.len() + members.len() + 1 > MAX_MEMBERS {
        return Err(archive_limit("Archive exceeds its file and folder limit"));
    }
    let mut folded = HashSet::new();
    for path in folders.iter().map(String::as_str).chain(paths) {
        if !folded.insert(path.to_uppercase())
            || path
                .rsplit_once('/')
                .is_some_and(|(parent, _)| parent != "assets" && !dirs.contains(parent))
        {
            return Err(invalid_archive(
                "Archive paths collide or lack a declared parent folder",
            ));
        }
    }
    Ok(())
}

fn allowed_name(name: &str) -> bool {
    matches!(name, MANIFEST | PROJECT | FOLDERS)
        || records::TABLES.iter().any(|table| table.name == name)
        || name.strip_prefix("files/").is_some_and(|path| {
            if let Some(blob) = path.strip_prefix("assets/") {
                files::valid_relative(blob)
                    && !blob.contains('/')
                    && blob
                        .strip_prefix("asset-")
                        .and_then(|value| value.split_once('.'))
                        .is_some_and(|(id, suffix)| {
                            Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
                                && matches!(
                                    suffix,
                                    "png"
                                        | "jpeg"
                                        | "webp"
                                        | "txt"
                                        | "md"
                                        | "pdf"
                                        | "docx"
                                        | "wav"
                                        | "webm"
                                        | "mp4"
                                )
                        })
            } else {
                files::working_path(path)
            }
        })
}

fn validate_directory_trailer(
    file: &mut (impl Read + Seek),
    size: u64,
    allowed: std::ops::RangeInclusive<usize>,
) -> Result<usize> {
    // Forge archives use a single disk and no EOCD comment. Bound the entry count before invoking ZIP's central-directory parser.
    if size < 22 {
        return Err(invalid_archive("ZIP end record is missing"));
    }
    file.seek(SeekFrom::End(-22))?;
    let mut end = [0u8; 22];
    file.read_exact(&mut end)?;
    if &end[..4] != b"PK\x05\x06" || end[4..8] != [0; 4] || end[20..22] != [0; 2] {
        return Err(invalid_archive(
            "ZIP must be a single archive without a trailer comment",
        ));
    }
    let short = u16::from_le_bytes(end[10..12].try_into().unwrap());
    if end[8..10] != end[10..12] {
        return Err(invalid_archive("ZIP has inconsistent entry counts"));
    }
    let count = if short != u16::MAX {
        u64::from(short)
    } else {
        if size < 98 {
            return Err(invalid_archive("ZIP64 end record is missing"));
        }
        file.seek(SeekFrom::End(-42))?;
        let mut locator = [0u8; 20];
        file.read_exact(&mut locator)?;
        if &locator[..8] != b"PK\x06\x07\0\0\0\0" || locator[16..20] != [1, 0, 0, 0] {
            return Err(invalid_archive("ZIP64 has invalid disk boundaries"));
        }
        let offset = u64::from_le_bytes(locator[8..16].try_into().unwrap());
        if offset.checked_add(56) != Some(size - 42) {
            return Err(invalid_archive("ZIP64 has invalid end record bounds"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut zip64 = [0u8; 56];
        file.read_exact(&mut zip64)?;
        if &zip64[..4] != b"PK\x06\x06" || zip64[16..24] != [0; 8] || zip64[24..32] != zip64[32..40]
        {
            return Err(invalid_archive("ZIP64 has inconsistent entry counts"));
        }
        u64::from_le_bytes(zip64[32..40].try_into().unwrap())
    };
    if !usize::try_from(count).is_ok_and(|count| allowed.contains(&count)) {
        return Err(archive_limit("ZIP entry count exceeds the backup budget"));
    }
    Ok(count as usize)
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o600)
        .large_file(true)
}

fn write_manifest<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    manifest: &ArchiveManifest,
    limit: u64,
) -> Result<()> {
    let encoded = serde_json::to_vec(manifest)?;
    if encoded.len() as u64 > limit {
        return Err(archive_limit("Backup manifest exceeds its size limit"));
    }
    zip_result(zip.start_file(MANIFEST, zip_options()))?;
    zip.write_all(&encoded)?;
    Ok(())
}

struct Builder<'a, W: Write + Seek> {
    zip: &'a mut ZipWriter<W>,
    bytes: u64,
    limit: u64,
    members: BTreeMap<String, Member>,
}

impl<W: Write + Seek> Builder<'_, W> {
    fn write(
        &mut self,
        path: &str,
        content: impl FnOnce(&mut DigestWriter<&mut ZipWriter<W>>) -> Result<Option<u64>>,
    ) -> Result<&Member> {
        zip_result(self.zip.start_file(path, zip_options()))?;
        let mut measured = DigestWriter::new(&mut *self.zip, self.limit - self.bytes);
        let records = content(&mut measured)?;
        let member = measured.finish(records);
        self.bytes += member.bytes;
        self.members.insert(path.into(), member);
        Ok(&self.members[path])
    }
}

struct DigestWriter<W> {
    inner: W,
    sha: Sha256,
    bytes: u64,
    limit: u64,
}
impl<W> DigestWriter<W> {
    fn new(inner: W, limit: u64) -> Self {
        Self {
            inner,
            sha: Sha256::new(),
            bytes: 0,
            limit,
        }
    }
    fn finish(self, records: Option<u64>) -> Member {
        Member {
            bytes: self.bytes,
            sha256: format!("{:x}", self.sha.finalize()),
            records,
        }
    }
}
impl<W: Write> Write for DigestWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.saturating_add(bytes.len() as u64) > self.limit {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        let n = self.inner.write(bytes)?;
        self.sha.update(&bytes[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

struct MeasureRead<R> {
    inner: R,
    hash: DigestWriter<io::Sink>,
}
impl<R: Read> MeasureRead<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            hash: DigestWriter::new(io::sink(), limit),
        }
    }
    fn finish(self, expected: &Member) -> Result<()> {
        let actual = self.hash.finish(None);
        if actual.bytes != expected.bytes || actual.sha256 != expected.sha256 {
            return Err(Error::Link(
                "BACKUP_CHECKSUM",
                "An archive member failed its SHA-256 check",
            ));
        }
        Ok(())
    }
}
impl<R: Read> Read for MeasureRead<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(bytes)?;
        self.hash.write_all(&bytes[..n])?;
        Ok(n)
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn zip_result<T>(result: ZipResult<T>) -> Result<T> {
    result.map_err(|error| match error {
        zip::result::ZipError::Io(error) => Error::Io(error),
        _ => invalid_archive("ZIP structure is invalid"),
    })
}
fn invalid_archive(message: &'static str) -> Error {
    Error::Link("BACKUP_INVALID", message)
}
fn boundary(message: &'static str) -> Error {
    Error::Link("BACKUP_PATH", message)
}
fn archive_limit(message: &'static str) -> Error {
    Error::Link("BACKUP_LIMIT", message)
}
fn workspace_changed() -> Error {
    Error::Link(
        "SOURCE_CHANGED",
        "Project files changed during export. Save the files and retry.",
    )
}

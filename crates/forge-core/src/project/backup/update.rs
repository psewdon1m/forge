use std::{
    io::Cursor,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::settings::{Preferences, ProfileSettings};

use super::*;

const MAX_UPDATE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_UPDATE_PROJECTS: usize = 128;
const RECEIPT_SECONDS: u64 = 15 * 60;
const LIMITS: ArchiveLimits = ArchiveLimits {
    zip: MAX_UPDATE_BYTES,
    unpacked: MAX_UPDATE_BYTES,
    manifest: MAX_MANIFEST,
    entries: 2..=MAX_MEMBERS,
};

/// The caller resolves the affected IDs and revisions from the candidate's migration contract.
pub struct UpdateBackupScope {
    pub job_id: Uuid,
    pub target_version: String,
    pub target_sha256: String,
    pub settings_revision: i64,
    pub projects: BTreeMap<Uuid, i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateProjectScope {
    pub project_id: Uuid,
    pub revision: i64,
    pub source_project_id: Option<Uuid>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryPoint {
    job_id: Uuid,
    target_version: String,
    target_sha256: String,
    settings_revision: i64,
    projects: Vec<UpdateProjectScope>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBackupInfo {
    pub source_version: String,
    pub created_at: String,
    pub archive_bytes: u64,
    pub archive_sha256: String,
    recovery: RecoveryPoint,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBackupReceipt {
    pub info: UpdateBackupInfo,
    pub saved_at_unix: u64,
}

impl UpdateBackupReceipt {
    pub fn check_install_age(&self) -> Result<()> {
        check_receipt_age(self.saved_at_unix, unix_seconds()?)
    }
}

impl UpdateBackupInfo {
    pub fn job_id(&self) -> Uuid {
        self.recovery.job_id
    }

    pub fn target(&self) -> (&str, &str) {
        (&self.recovery.target_version, &self.recovery.target_sha256)
    }

    pub fn projects(&self) -> &[UpdateProjectScope] {
        &self.recovery.projects
    }

    pub fn settings_revision(&self) -> i64 {
        self.recovery.settings_revision
    }
}

/// Owns one bounded ZIP and pins the source handles until update acceptance or cancellation.
pub struct PreparedUpdateBackup<'a> {
    bytes: Vec<u8>,
    info: UpdateBackupInfo,
    _settings_lock: rusqlite::Transaction<'a>,
    projects: Vec<ProjectSnapshot<'a>>,
    receipt: Option<(UpdateBackupReceipt, PathBuf)>,
}

pub fn prepare_update_backup<'a>(
    settings_store: &'a mut ProfileSettings,
    scope: UpdateBackupScope,
    projects: Vec<&'a mut Project>,
) -> Result<PreparedUpdateBackup<'a>> {
    if projects.len() != scope.projects.len() || projects.len() > MAX_UPDATE_PROJECTS {
        return Err(scope_error());
    }
    let (settings_lock, settings_state) = settings_store.snapshot_lock(scope.settings_revision)?;
    let mut captured = Vec::with_capacity(projects.len());
    let mut seen = HashSet::new();
    let mut raw_bytes = 0;
    let mut member_count = 2;
    for source in projects {
        let revision = scope
            .projects
            .get(&source.id)
            .filter(|_| seen.insert(source.id))
            .ok_or_else(scope_error)?;
        let snapshot = ProjectSnapshot::capture(source, *revision, MAX_UPDATE_BYTES - raw_bytes)?;
        raw_bytes += snapshot.raw;
        member_count +=
            FIXED_MEMBERS - 1 + snapshot.tree.files.len() + snapshot.tree.directories.len();
        if member_count > MAX_MEMBERS {
            return Err(archive_limit(
                "The update scope exceeds the backup entry limit",
            ));
        }
        captured.push(snapshot);
    }
    captured.sort_by_key(|project| project.data.project_id);
    let point = RecoveryPoint {
        job_id: scope.job_id,
        target_version: scope.target_version,
        target_sha256: scope.target_sha256,
        settings_revision: settings_state.revision,
        projects: captured
            .iter()
            .map(|snapshot| UpdateProjectScope {
                project_id: snapshot.data.project_id,
                revision: snapshot.data.revision,
                source_project_id: snapshot.project.source_project_id,
            })
            .collect(),
    };
    validate_point(&point)?;

    let mut zip = ZipWriter::new(UpdateBuffer(Cursor::new(Vec::new())));
    let mut builder = Builder {
        zip: &mut zip,
        bytes: 0,
        limit: LIMITS.zip,
        members: BTreeMap::new(),
    };
    settings::write_snapshot(&mut builder, settings_state.preferences)?;
    for project in &captured {
        project
            .write(&mut builder, &prefix(project.data.project_id))
            .map_err(update_limit_error)?;
    }
    for project in &captured {
        project.verify_tree()?;
    }
    let created_at =
        settings_lock.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })?;
    let manifest = ArchiveManifest {
        format: FORMAT.into(),
        schema_version: VERSION,
        source_version: env!("CARGO_PKG_VERSION").into(),
        source_project_id: None,
        project_schema: Some(SCHEMA),
        scope: "update".into(),
        restore_mode: "revert".into(),
        created_at,
        excluded_entries: captured.iter().map(|project| project.tree.excluded).sum(),
        update: Some(point),
        members: builder.members,
    };
    write_manifest(&mut zip, &manifest, LIMITS.manifest).map_err(update_limit_error)?;
    let bytes = zip_result(zip.finish())
        .map_err(update_limit_error)?
        .0
        .into_inner();
    let verified = inspect(Cursor::new(bytes.as_slice()), bytes.len() as u64)?;
    let info = verified.info;
    Ok(PreparedUpdateBackup {
        bytes,
        info,
        _settings_lock: settings_lock,
        projects: captured,
        receipt: None,
    })
}

impl PreparedUpdateBackup<'_> {
    pub fn info(&self) -> &UpdateBackupInfo {
        &self.info
    }

    pub fn save(&mut self, destination: &Path) -> Result<UpdateBackupReceipt> {
        if self.receipt.is_some() {
            return Err(Error::Invalid("The update backup was already saved"));
        }
        self.verify_sources()?;
        let destination = files::absolute_destination(destination)?;
        if !destination
            .extension()
            .and_then(|part| part.to_str())
            .is_some_and(|part| part.eq_ignore_ascii_case("zip"))
            || self
                .projects
                .iter()
                .any(|item| path_within(&destination, &item.project.canonical_root))
        {
            return Err(boundary(
                "Choose a .zip destination outside the affected projects",
            ));
        }
        let parent = destination.parent().expect("checked destination");
        files::ensure_space(parent, self.info.archive_bytes)?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    Error::ExportExists
                } else {
                    error.into()
                }
            })?;
        let result: Result<UpdateBackupReceipt> = (|| {
            file.write_all(&self.bytes)?;
            file.sync_all()?;
            file.rewind()?;
            verify_saved_bytes(&mut file, &self.info)?;
            Ok(UpdateBackupReceipt {
                info: self.info.clone(),
                saved_at_unix: unix_seconds()?,
            })
        })();
        drop(file);
        if result.is_err() {
            let _ = fs::remove_file(&destination);
        }
        let receipt = result?;
        self.receipt = Some((receipt.clone(), destination));
        Ok(receipt)
    }

    /// Used immediately before helper acceptance. The bytes are borrowed from the same saved ZIP.
    pub fn for_install(&self, receipt: &UpdateBackupReceipt) -> Result<&[u8]> {
        let (_, path) = self
            .receipt
            .as_ref()
            .filter(|(saved, _)| saved == receipt)
            .ok_or_else(receipt_mismatch)?;
        receipt.check_install_age()?;
        self.verify_sources()?;
        let mut file = files::open_archive(path).map_err(|_| receipt_mismatch())?;
        verify_saved_bytes(&mut file, &self.info)?;
        Ok(&self.bytes)
    }

    fn verify_sources(&self) -> Result<()> {
        for project in &self.projects {
            project.verify_tree()?;
        }
        Ok(())
    }
}

fn verify_saved_bytes(file: &mut File, expected: &UpdateBackupInfo) -> Result<()> {
    if file.metadata()?.len() != expected.archive_bytes {
        return Err(receipt_mismatch());
    }
    let mut measured = DigestWriter::new(io::sink(), MAX_UPDATE_BYTES);
    io::copy(file, &mut measured)?;
    let written = measured.finish(None);
    if written.sha256 != expected.archive_sha256 || written.bytes != expected.archive_bytes {
        return Err(receipt_mismatch());
    }
    Ok(())
}

fn check_receipt_age(saved_at: u64, now: u64) -> Result<()> {
    if now
        .checked_sub(saved_at)
        .is_some_and(|age| age < RECEIPT_SECONDS)
    {
        return Ok(());
    }
    Err(Error::Link(
        "BACKUP_RECEIPT",
        "The update backup receipt has expired",
    ))
}

pub struct RecoveredUpdateBackup {
    zip: ZipArchive<Cursor<Vec<u8>>>,
    info: UpdateBackupInfo,
    preferences: Preferences,
    projects: BTreeMap<Uuid, ProjectPayload>,
}

/// Opens the operator-selected ZIP using the exact receipt stored with the update job.
/// Recovery can take place after the installation receipt expires.
pub fn open_update_backup(
    path: &Path,
    receipt: &UpdateBackupReceipt,
) -> Result<RecoveredUpdateBackup> {
    let mut file = files::open_archive(path)?;
    let length = file.metadata()?.len();
    if length > MAX_UPDATE_BYTES {
        return Err(archive_limit("Update ZIP exceeds the 128 MiB limit"));
    }
    if length != receipt.info.archive_bytes {
        return Err(receipt_mismatch());
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length as usize)
        .map_err(|_| archive_limit("Unable to reserve memory for the update ZIP"))?;
    bytes.resize(length as usize, 0);
    file.read_exact(&mut bytes)?;
    if file.read(&mut [0])? != 0 {
        return Err(receipt_mismatch());
    }
    RecoveredUpdateBackup::from_bytes(bytes, receipt)
}

impl RecoveredUpdateBackup {
    pub fn from_bytes(bytes: Vec<u8>, receipt: &UpdateBackupReceipt) -> Result<Self> {
        let length = bytes.len() as u64;
        if length > MAX_UPDATE_BYTES {
            return Err(archive_limit("Update ZIP exceeds the 128 MiB limit"));
        }
        if length != receipt.info.archive_bytes || digest(&bytes) != receipt.info.archive_sha256 {
            return Err(receipt_mismatch());
        }
        let verified = inspect(Cursor::new(bytes), length)?;
        if verified.info != receipt.info {
            return Err(receipt_mismatch());
        }
        Ok(Self {
            zip: verified.zip,
            info: verified.info,
            preferences: verified.preferences,
            projects: verified.projects,
        })
    }

    pub fn preferences(&self) -> Preferences {
        self.preferences
    }

    /// Reconstructs a verified project tree for the updater's activation transaction.
    /// Preserves the project identity, original provenance and revision digests.
    pub fn stage_project(&mut self, project_id: Uuid, destination: &Path) -> Result<ProjectView> {
        let project = self.projects.get(&project_id).ok_or_else(scope_error)?;
        let source = self
            .info
            .projects()
            .iter()
            .find(|item| item.project_id == project_id)
            .ok_or_else(scope_error)?;
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
                "Choose a staging location outside the existing project",
            ));
        }
        files::ensure_space(parent, project.restore_bytes())?;
        let scratch = files::Scratch::create(parent)?;
        let view = materialize_project(
            &mut self.zip,
            project,
            &prefix(project_id),
            scratch.path(),
            project_id,
            source.source_project_id,
        )?;
        files::publish(scratch.path(), &destination)?;
        scratch.release();
        Ok(view)
    }
}

struct Verified<R> {
    zip: ZipArchive<R>,
    info: UpdateBackupInfo,
    preferences: Preferences,
    projects: BTreeMap<Uuid, ProjectPayload>,
}

fn inspect<R: Read + Seek>(file: R, archive_bytes: u64) -> Result<Verified<R>> {
    let Envelope {
        mut zip,
        manifest,
        archive_sha256,
        ..
    } = inspect_envelope(file, archive_bytes, LIMITS, |name| {
        matches!(name, MANIFEST | settings::SETTINGS)
            || split_project_member(name)
                .is_some_and(|(_, part)| part != MANIFEST && allowed_name(part))
    })?;
    if manifest.scope != "update"
        || manifest.restore_mode != "revert"
        || manifest.source_project_id.is_some()
    {
        return Err(scope_error());
    }
    let project_schema = manifest.project_schema.ok_or_else(scope_error)?;
    if project_schema != SCHEMA {
        return Err(Error::UnsupportedSchema(project_schema));
    }
    let point = manifest.update.ok_or_else(scope_error)?;
    validate_point(&point)?;
    let preferences = settings::read_snapshot(&mut zip, &manifest.members)?;
    let mut project_members = BTreeMap::<Uuid, BTreeMap<String, Member>>::new();
    let mut count = 2;
    for (name, member) in manifest.members {
        if name == settings::SETTINGS {
            continue;
        }
        let (id, part) = split_project_member(&name).ok_or_else(scope_error)?;
        project_members
            .entry(id)
            .or_default()
            .insert(part.into(), member);
        count += 1;
    }
    if project_members.len() != point.projects.len() {
        return Err(scope_error());
    }
    let mut projects = BTreeMap::new();
    for scoped in &point.projects {
        let id = scoped.project_id;
        let members = project_members.remove(&id).ok_or_else(scope_error)?;
        let payload = inspect_project(&mut zip, &prefix(id), members, id)?;
        if payload.project.revision != scoped.revision {
            return Err(scope_error());
        }
        count += payload.folders.len();
        if count > MAX_MEMBERS {
            return Err(archive_limit(
                "The update scope exceeds the backup entry limit",
            ));
        }
        projects.insert(id, payload);
    }
    let info = UpdateBackupInfo {
        source_version: manifest.source_version,
        created_at: manifest.created_at,
        archive_bytes,
        archive_sha256,
        recovery: point,
    };
    Ok(Verified {
        zip,
        info,
        preferences,
        projects,
    })
}

fn validate_point(point: &RecoveryPoint) -> Result<()> {
    if point.job_id.is_nil()
        || point.settings_revision < 0
        || point.projects.len() > MAX_UPDATE_PROJECTS
        || !valid_hash(&point.target_sha256)
        || point.target_version.len() > 64
        || !point
            .target_version
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_digit)
        || !point
            .target_version
            .bytes()
            .all(|char| char.is_ascii_alphanumeric() || b".+-".contains(&char))
        || point.projects.iter().any(|item| {
            item.project_id.is_nil()
                || item.revision < 0
                || item
                    .source_project_id
                    .is_some_and(|source| source.is_nil() || source == item.project_id)
        })
        || !point
            .projects
            .windows(2)
            .all(|pair| pair[0].project_id < pair[1].project_id)
    {
        return Err(scope_error());
    }
    Ok(())
}

fn prefix(id: Uuid) -> String {
    format!("projects/{id}/")
}

fn split_project_member(name: &str) -> Option<(Uuid, &str)> {
    let (id, part) = name.strip_prefix("projects/")?.split_once('/')?;
    let parsed = Uuid::parse_str(id).ok()?;
    (parsed.to_string() == id && !parsed.is_nil()).then_some((parsed, part))
}

fn scope_error() -> Error {
    Error::Link(
        "BACKUP_SCOPE",
        "The update archive does not match the requested project and settings scope",
    )
}

fn receipt_mismatch() -> Error {
    Error::Link(
        "BACKUP_RECEIPT",
        "The selected ZIP does not match the saved update backup receipt",
    )
}

fn unix_seconds() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| Error::Invalid("Correct the system clock before saving an update backup"))
}

fn update_limit_error(error: Error) -> Error {
    if matches!(&error, Error::Io(io) if io.kind() == io::ErrorKind::FileTooLarge) {
        archive_limit("The full update ZIP exceeds 128 MiB")
    } else {
        error
    }
}

struct UpdateBuffer(Cursor<Vec<u8>>);

impl Write for UpdateBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let end = self.0.position().saturating_add(bytes.len() as u64);
        if end > MAX_UPDATE_BYTES {
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        let buffer = self.0.get_mut();
        let end = end as usize;
        if end > buffer.capacity() {
            let reserve = end.next_power_of_two().min(MAX_UPDATE_BYTES as usize);
            buffer
                .try_reserve_exact(reserve - buffer.len())
                .map_err(io::Error::other)?;
        }
        self.0.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl Seek for UpdateBuffer {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.0.seek(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_receipt_expires_at_fifteen_minutes_and_rejects_a_reversed_clock() {
        let saved_at = 1_000;
        assert!(check_receipt_age(saved_at, saved_at + 899).is_ok());
        assert_eq!(
            check_receipt_age(saved_at, saved_at + 900)
                .unwrap_err()
                .code(),
            "BACKUP_RECEIPT"
        );
        assert_eq!(
            check_receipt_age(saved_at, saved_at - 1)
                .unwrap_err()
                .code(),
            "BACKUP_RECEIPT"
        );
    }
}

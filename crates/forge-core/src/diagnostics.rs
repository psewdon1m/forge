use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    Error, Result,
    assets::valid_sha,
    project::is_link,
    storage::{available_bytes, rename_exclusive},
};

mod archive;

const AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const AUDIT_EVENTS: i64 = 10_000;
const AUDIT_BYTES: usize = 64 * 1024 * 1024;
const DIRECTORY_BYTES: u64 = 64 * 1024 * 1024;
const EVENT_BYTES: usize = 8 * 1024;
const AUDIT_EVENT_BYTES: usize = AUDIT_BYTES / AUDIT_EVENTS as usize;
const FILE_BYTES: u64 = 5 * 1024 * 1024;
const FILE_COUNT: usize = 6;
const PAGE: usize = 200;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Start,
    Exit,
    AccessDenied,
    Create,
    Open,
    OpenRecent,
    Close,
    Archive,
    Apply,
    ImportAssets,
    DirectoryChange,
    EditTextAsset,
    ReplaceAsset,
    OpenEditCopy,
    ImportEditCopy,
    DiscardEditCopy,
    OpenAsset,
    DownloadAsset,
    RunPalette,
    RunMetadata,
    RunComparison,
    BackupExport,
    BackupInspect,
    BackupRestore,
    DatasetRead,
    DatasetExport,
    SchemeRead,
    SchemeExport,
    SettingsSave,
    SettingsBackupExport,
    SettingsBackupInspect,
    SettingsBackupRestore,
    LogsExport,
    UpdateCheck,
    UpdateStage,
}

impl Action {
    fn operational(self) -> bool {
        matches!(self, Self::Start | Self::Exit)
    }

    fn summary(self) -> &'static str {
        match self {
            Self::Start => "Started Forge",
            Self::Exit => "Closed Forge",
            Self::AccessDenied => "Rejected access from an untrusted frame",
            Self::Create => "Create project",
            Self::Open | Self::OpenRecent => "Open project",
            Self::Close => "Close project",
            Self::Archive => "Archive project",
            Self::Apply => "Save Space change",
            Self::ImportAssets => "Import files",
            Self::DirectoryChange => "Change working tree",
            Self::EditTextAsset => "Save file as a new version",
            Self::ReplaceAsset => "Replace file",
            Self::OpenEditCopy => "Open writable document copy",
            Self::ImportEditCopy => "Import document edits",
            Self::DiscardEditCopy => "Discard writable document copy",
            Self::OpenAsset => "Open file",
            Self::DownloadAsset => "Save verified file",
            Self::RunPalette => "Calculate Palette",
            Self::RunMetadata => "Read Metadata",
            Self::RunComparison => "Calculate Comparison",
            Self::BackupExport => "Export project backup",
            Self::BackupInspect => "Inspect project backup",
            Self::BackupRestore => "Restore project backup",
            Self::DatasetRead => "Read a tabular import",
            Self::DatasetExport => "Export Dataset",
            Self::SchemeRead => "Read Scheme JSON",
            Self::SchemeExport => "Export Scheme JSON",
            Self::SettingsSave => "Save application preferences",
            Self::SettingsBackupExport => "Export settings backup",
            Self::SettingsBackupInspect => "Inspect settings backup",
            Self::SettingsBackupRestore => "Restore settings backup",
            Self::LogsExport => "Export diagnostics archive",
            Self::UpdateCheck => "Check Stable release metadata",
            Self::UpdateStage => "Prepare signed update",
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Outcome {
    Success,
    Canceled,
    Error,
    Denied,
    Warning,
}

impl Outcome {
    fn is_error(self) -> bool {
        matches!(self, Self::Error | Self::Denied)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    action: Action,
    outcome: Outcome,
    correlation_id: Uuid,
    project_id: Option<Uuid>,
    error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    update_failure: Option<UpdateFailureContext>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateFailureCode {
    ChannelOffline,
    ChannelDns,
    ChannelTls,
    ChannelTimeout,
    ChannelUnavailable,
    ChannelIndexHttp,
    ChannelMetadataHttp,
    InvalidIndex,
    NoRelease,
    UntrustedRelease,
    VersionConflict,
    SelectionChanged,
    IncompatibleRelease,
    UnsupportedUpdatePolicy,
    PackageHttp,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum UpdateHttpEndpoint {
    #[serde(rename = "api.github.com")]
    GitHubApi,
    #[serde(rename = "github.com")]
    GitHub,
    #[serde(rename = "release-assets.githubusercontent.com")]
    ReleaseAssets,
    #[serde(rename = "objects.githubusercontent.com")]
    Objects,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateHttpFailure {
    pub status: u16,
    pub endpoint: UpdateHttpEndpoint,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateFailureContext {
    stage: UpdateFailureStage,
    code: UpdateFailureCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    http: Option<UpdateHttpFailure>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateFailureStage {
    Metadata,
    Download,
}

impl UpdateFailureContext {
    fn valid(&self) -> bool {
        use UpdateFailureCode::{ChannelIndexHttp, ChannelMetadataHttp, PackageHttp};
        use UpdateFailureStage::{Download, Metadata};

        if let Some(http) = self.http
            && (!(100..600).contains(&http.status) || http.status == 200)
        {
            return false;
        }
        match (&self.stage, self.code, self.http) {
            (Metadata, ChannelIndexHttp, Some(http)) => {
                http.endpoint == UpdateHttpEndpoint::GitHubApi
            }
            (Metadata, ChannelMetadataHttp, Some(http)) | (Download, PackageHttp, Some(http)) => {
                http.endpoint != UpdateHttpEndpoint::GitHubApi
            }
            (Metadata, code, None) => {
                !matches!(code, ChannelIndexHttp | ChannelMetadataHttp | PackageHttp)
            }
            _ => false,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateArchiveContext {
    installed_package_sha256: String,
    job: Option<UpdateArchiveJob>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateArchiveJob {
    id: Uuid,
    phase: UpdateJobPhase,
    source_version: String,
    target_version: String,
    target_package_sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateJobPhase {
    Preparing,
    BackupSaved,
    Downloading,
    Verifying,
    Staged,
    Failed,
    Interrupted,
    Starting,
    Healthy,
    RollingBack,
    RolledBack,
    ManualRollingBack,
    ManualRolledBack,
    RecoveryRequired,
}

impl UpdateArchiveContext {
    fn validate(&self) -> Result<()> {
        if !valid_sha(&self.installed_package_sha256)
            || self.job.as_ref().is_some_and(|job| {
                job.id.is_nil()
                    || !valid_sha(&job.target_package_sha256)
                    || !stable_version(&job.source_version)
                    || !stable_version(&job.target_version)
            })
        {
            return Err(Error::Invalid("Invalid update diagnostics context"));
        }
        Ok(())
    }
}

fn stable_version(value: &str) -> bool {
    let mut parts = value.split('.');
    (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty()
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u64>().is_ok()
        })
    }) && parts.next().is_none()
}

impl Observation {
    fn sanitize(&mut self) {
        if !matches!(self.action, Action::UpdateCheck | Action::UpdateStage)
            || !matches!(self.outcome, Outcome::Error)
            || self.update_failure.as_ref().is_some_and(|failure| {
                !failure.valid()
                    || matches!(self.action, Action::UpdateCheck)
                        && !matches!(failure.stage, UpdateFailureStage::Metadata)
            })
        {
            self.update_failure = None;
        }
        self.error_code = if self.outcome.is_error() || matches!(self.outcome, Outcome::Warning) {
            Some(safe_error(self.error_code.as_deref()).into())
        } else {
            None
        };
    }
}

fn safe_error(value: Option<&str>) -> &'static str {
    const CODES: &[&str] = &[
        "ASSET_INTEGRITY",
        "ASSET_UNAVAILABLE",
        "BACKUP_CHANGED",
        "BACKUP_CHECKSUM",
        "BACKUP_INVALID",
        "BACKUP_LIMIT",
        "BACKUP_PATH",
        "BACKUP_SELECTION",
        "COLOR_PROFILE_UNSUPPORTED",
        "COMPARISON_UNSUPPORTED",
        "CORE_UNAVAILABLE",
        "DIRECTORY_CHANGED",
        "DATASET_ENCODING",
        "DATASET_INVALID",
        "DATASET_LIMIT",
        "DIRECTORY_IO_ERROR",
        "EDIT_COPY_IO_ERROR",
        "EDIT_COPY_STALE",
        "EDIT_COPY_UNAVAILABLE",
        "EDITOR_UNAVAILABLE",
        "EXPORT_EXISTS",
        "FORBIDDEN",
        "INVALID_INPUT",
        "LIMIT_EXCEEDED",
        "LINK_CARDINALITY",
        "LINK_CONTRACT",
        "LINK_CYCLE",
        "LINK_DUPLICATE",
        "LINK_ENDPOINT",
        "LINK_INCOMPATIBLE",
        "LOGS_UNAVAILABLE",
        "OPEN_IO_ERROR",
        "PROJECT_BUSY",
        "PROJECT_CATALOG",
        "PROJECT_CHANGED",
        "PROJECT_CORRUPT",
        "PROJECT_EXISTS",
        "PROJECT_IO_ERROR",
        "PROJECT_LOCKED",
        "PROJECT_NOT_RECENT",
        "PROJECT_UNAVAILABLE",
        "REVISION_CONFLICT",
        "SCHEMA_UNSUPPORTED",
        "SCHEME_INVALID",
        "SCHEME_LIMIT",
        "SETTINGS_CHANGED",
        "SETTINGS_UNAVAILABLE",
        "SOURCE_CHANGED",
        "SOURCE_NOT_FOUND",
        "STORAGE_FULL",
        "UPDATE_CHANNEL_FAILED",
        "UPDATE_PREPARATION_FAILED",
        "VIEWER_UNAVAILABLE",
    ];
    CODES
        .iter()
        .find(|code| Some(**code) == value)
        .copied()
        .unwrap_or("UNCLASSIFIED")
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredEvent {
    id: Uuid,
    occurred_at: i64,
    observation: Observation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event<'a> {
    id: Uuid,
    occurred_at: i64,
    severity: &'static str,
    outcome: Outcome,
    action: Action,
    actor: &'static str,
    actor_type: &'static str,
    target: &'static str,
    target_id: Option<Uuid>,
    summary: &'static str,
    correlation_id: Uuid,
    transport: &'static str,
    context: Option<&'a UpdateFailureContext>,
    error: Option<EventError<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventError<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    code: &'a str,
    message: Option<&'static str>,
    cause: Option<&'static str>,
    stack_trace: Option<&'static str>,
}

impl StoredEvent {
    fn event(&self) -> Event<'_> {
        let row = &self.observation;
        let severity = match row.outcome {
            Outcome::Error | Outcome::Denied => "error",
            Outcome::Warning => "warning",
            Outcome::Success | Outcome::Canceled => "info",
        };
        Event {
            id: self.id,
            occurred_at: self.occurred_at,
            severity,
            outcome: row.outcome,
            action: row.action,
            actor: "local OS user",
            actor_type: "os-user",
            target: if row.project_id.is_some() {
                "Project"
            } else {
                "Forge"
            },
            target_id: row.project_id,
            summary: row.action.summary(),
            correlation_id: row.correlation_id,
            transport: if row.action.operational() {
                "desktop"
            } else {
                "desktop-ipc"
            },
            context: row.update_failure.as_ref(),
            error: row.error_code.as_deref().map(|code| EventError {
                kind: if matches!(row.outcome, Outcome::Denied) {
                    "AccessDenied"
                } else {
                    "OperationError"
                },
                code,
                message: None,
                cause: None,
                stack_trace: None,
            }),
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    occurred_at: i64,
    sequence: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    rows: Vec<serde_json::Value>,
    older: Option<Cursor>,
    space_low: bool,
}

struct Segment {
    path: PathBuf,
    started_at: i64,
    bytes: u64,
}

pub struct Diagnostics {
    db: Connection,
    root: PathBuf,
    _lock: File,
    active: Option<Segment>,
    maintenance_day: i64,
    space_checked: Option<(i64, bool)>,
}

impl Diagnostics {
    pub fn open(profile: &Path) -> Result<Self> {
        if !profile.is_absolute() {
            return Err(unavailable());
        }
        fs::create_dir_all(profile)?;
        let root = fs::canonicalize(profile)?.join("diagnostics");
        match fs::create_dir(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let root_meta = fs::symlink_metadata(&root)?;
        if !root_meta.is_dir() || is_link(&root_meta) {
            return Err(unavailable());
        }
        for name in ["audit.sqlite", "audit.sqlite-journal", "diagnostics.lock"] {
            regular_if_present(&root.join(name))?;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("diagnostics.lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(unavailable()),
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
        let db = Connection::open(root.join("audit.sqlite"))?;
        db.busy_timeout(Duration::from_secs(1))?;
        let schema: u32 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if schema > 1 {
            return Err(Error::UnsupportedSchema(schema));
        }
        db.execute_batch(
            "PRAGMA trusted_schema = OFF;
             PRAGMA journal_mode = DELETE;
             PRAGMA synchronous = FULL;
             PRAGMA page_size = 4096;
             PRAGMA max_page_count = 4096;
             CREATE TABLE IF NOT EXISTS events (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 occurred_at INTEGER NOT NULL,
                 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 6710)
             ) STRICT;
             CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at DESC, sequence DESC);
             PRAGMA user_version = 1;",
        )?;
        let mut store = Self {
            db,
            root,
            _lock: lock,
            active: None,
            maintenance_day: -1,
            space_checked: None,
        };
        store.prune(now()?)?;
        Ok(store)
    }

    pub fn record(&mut self, observation: Observation) -> Result<bool> {
        let at = now()?;
        self.maintain(at)?;
        self.record_at(observation, at)?;
        Ok(self.space_low(at))
    }

    fn record_at(&mut self, mut observation: Observation, occurred_at: i64) -> Result<()> {
        observation.sanitize();
        let event = StoredEvent {
            id: Uuid::new_v4(),
            occurred_at,
            observation,
        };
        if event.observation.action.operational() {
            let mut encoded = serde_json::to_vec(&event)?;
            encoded.push(b'\n');
            if encoded.len() > EVENT_BYTES {
                return Err(unavailable());
            }
            return self.append_operational(&encoded, occurred_at);
        }
        let encoded = serde_json::to_string(&event)?;
        if encoded.len() > AUDIT_EVENT_BYTES {
            return Err(unavailable());
        }
        let change = self.db.transaction()?;
        change.execute(
            "INSERT INTO events(occurred_at, payload) VALUES (?1, ?2)",
            params![occurred_at, encoded],
        )?;
        prune_audit(&change, occurred_at)?;
        change.commit()?;
        Ok(())
    }

    fn prune(&mut self, at: i64) -> Result<()> {
        let change = self.db.transaction()?;
        prune_audit(&change, at)?;
        change.commit()?;
        self.prune_segments(at, FILE_COUNT)?;
        self.maintenance_day = at / DAY_MS;
        Ok(())
    }

    fn maintain(&mut self, at: i64) -> Result<()> {
        if self.maintenance_day != at / DAY_MS {
            self.prune(at)?;
        }
        Ok(())
    }

    fn space_low(&mut self, at: i64) -> bool {
        if let Some((checked_at, low)) = self.space_checked
            && (checked_at..checked_at + 60_000).contains(&at)
        {
            return low;
        }
        let low = available_bytes(&self.root).is_ok_and(|free| free < DIRECTORY_BYTES);
        self.space_checked = Some((at, low));
        low
    }

    fn append_operational(&mut self, encoded: &[u8], at: i64) -> Result<()> {
        let additional = encoded.len() as u64;
        let rotate = self.active.as_ref().is_none_or(|segment| {
            segment.bytes + additional > FILE_BYTES || segment.started_at / DAY_MS != at / DAY_MS
        });
        if rotate {
            self.prune_segments(at, FILE_COUNT - 1)?;
            let path = self
                .root
                .join(format!("runtime-{at:013}-{}.jsonl", Uuid::new_v4()));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            file.write_all(encoded)?;
            self.active = Some(Segment {
                path,
                started_at: at,
                bytes: additional,
            });
        } else if let Some(segment) = &mut self.active {
            regular_if_present(&segment.path)?;
            let mut file = OpenOptions::new().append(true).open(&segment.path)?;
            file.write_all(encoded)?;
            segment.bytes += additional;
        }
        Ok(())
    }

    fn segments(&self) -> Result<Vec<Segment>> {
        let mut entries = Vec::with_capacity(FILE_COUNT + 1);
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some((timestamp, uuid)) = name.to_str().and_then(|name| {
                name.strip_prefix("runtime-")?
                    .strip_suffix(".jsonl")?
                    .split_once('-')
            }) else {
                continue;
            };
            let Ok(started_at) = timestamp.parse::<i64>() else {
                continue;
            };
            if timestamp.len() != 13 || Uuid::parse_str(uuid).is_err() {
                continue;
            }
            let meta = fs::symlink_metadata(entry.path())?;
            if !meta.is_file() || is_link(&meta) {
                return Err(unavailable());
            }
            entries.push(Segment {
                path: entry.path(),
                started_at,
                bytes: meta.len(),
            });
            if entries.len() > 64 {
                return Err(unavailable());
            }
        }
        entries.sort_by(|a, b| (a.started_at, &a.path).cmp(&(b.started_at, &b.path)));
        Ok(entries)
    }

    fn prune_segments(&mut self, at: i64, limit: usize) -> Result<()> {
        let entries = self.segments()?;
        let excess = entries.len().saturating_sub(limit);
        for (index, entry) in entries.into_iter().enumerate() {
            if index < excess || entry.started_at < at - AGE_MS || entry.bytes > FILE_BYTES {
                fs::remove_file(&entry.path)?;
                if self
                    .active
                    .as_ref()
                    .is_some_and(|active| active.path == entry.path)
                {
                    self.active = None;
                }
            }
        }
        Ok(())
    }

    pub fn page(&mut self, cursor: Option<Cursor>) -> Result<Page> {
        let at = now()?;
        self.maintain(at)?;
        let space_low = self.space_low(at);
        let cutoff = at - AGE_MS;
        let mut output = Vec::with_capacity(PAGE);
        let mut page_cursor = None;
        let mut query = self.db.prepare(
            "SELECT occurred_at, sequence, payload FROM events
             WHERE occurred_at >= ?1 AND (occurred_at, sequence) < (?2, ?3)
             ORDER BY occurred_at DESC, sequence DESC LIMIT ?4",
        )?;
        let cursor = cursor.unwrap_or(Cursor {
            occurred_at: i64::MAX,
            sequence: i64::MAX,
        });
        let mut rows = query.query(params![
            cutoff,
            cursor.occurred_at,
            cursor.sequence,
            PAGE as i64 + 1
        ])?;
        let mut older = None;
        while let Some(row) = rows.next()? {
            if output.len() == PAGE {
                older = page_cursor;
                break;
            }
            let event = parse_record(&row.get::<_, String>(2)?)?;
            output.push(serde_json::to_value(event.event())?);
            page_cursor = Some(Cursor {
                occurred_at: row.get(0)?,
                sequence: row.get(1)?,
            });
        }
        Ok(Page {
            rows: output,
            older,
            space_low,
        })
    }
}

fn prune_audit(db: &Connection, at: i64) -> Result<()> {
    db.execute("DELETE FROM events WHERE occurred_at < ?1", [at - AGE_MS])?;
    db.execute(
        "DELETE FROM events WHERE (occurred_at, sequence) < (
            SELECT occurred_at, sequence FROM events ORDER BY occurred_at DESC, sequence DESC
            LIMIT 1 OFFSET ?1
        )",
        [AUDIT_EVENTS - 1],
    )?;
    Ok(())
}

fn parse_record(encoded: &str) -> Result<StoredEvent> {
    if encoded.len() > EVENT_BYTES {
        return Err(unavailable());
    }
    let mut event: StoredEvent = serde_json::from_str(encoded)?;
    event.observation.sanitize();
    Ok(event)
}

fn now() -> Result<i64> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| unavailable())?;
    i64::try_from(elapsed.as_millis()).map_err(|_| unavailable())
}

fn regular_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !is_link(&meta) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(unavailable()),
        Err(error) => Err(error.into()),
    }
}

fn unavailable() -> Error {
    Error::Link("LOGS_UNAVAILABLE", "Forge diagnostics are unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Profile(PathBuf);

    impl Profile {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("forge-log-test-{}", Uuid::new_v4())))
        }
    }

    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn observation(action: Action, outcome: Outcome, code: Option<&str>) -> Observation {
        Observation {
            update_failure: None,
            action,
            outcome,
            correlation_id: Uuid::new_v4(),
            project_id: None,
            error_code: code.map(str::to_owned),
        }
    }

    #[test]
    fn keeps_bounded_audit_with_stable_pages_and_strips_unknown_diagnostics() {
        let profile = Profile::new();
        let mut store = Diagnostics::open(&profile.0).unwrap();
        assert_eq!(
            Diagnostics::open(&profile.0).err().unwrap().code(),
            "LOGS_UNAVAILABLE"
        );
        let at = now().unwrap();
        store
            .record_at(
                observation(Action::Archive, Outcome::Success, None),
                at - AGE_MS - 1,
            )
            .unwrap();
        // Seed a complete retained window so the next real append exercises the count
        // boundary in the same transaction. The 10,000 records share one timestamp.
        let encoded = serde_json::to_string(&StoredEvent {
            id: Uuid::new_v4(),
            occurred_at: at,
            observation: observation(Action::Apply, Outcome::Success, None),
        })
        .unwrap();
        store.db.execute(
            "WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?3)
             INSERT INTO events(occurred_at, payload) SELECT ?1, ?2 FROM sequence",
            params![at, encoded, AUDIT_EVENTS],
        ).unwrap();
        store
            .record_at(
                observation(
                    Action::BackupInspect,
                    Outcome::Error,
                    Some("Bearer synthetic secret"),
                ),
                at,
            )
            .unwrap();
        let count: i64 = store
            .db
            .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, AUDIT_EVENTS);
        let page = store.page(None).unwrap();
        assert_eq!(page.rows.len(), PAGE);
        assert_eq!(page.rows[0]["error"]["code"], "UNCLASSIFIED");
        let first_cursor = page.older.unwrap();
        assert_eq!(first_cursor.occurred_at, at);
        let next = store.page(Some(first_cursor)).unwrap();
        assert_eq!(
            next.older.unwrap().sequence,
            first_cursor.sequence - PAGE as i64
        );
        let aged: i64 = store
            .db
            .query_row(
                "SELECT count(*) FROM events WHERE occurred_at < ?1",
                [at - AGE_MS],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(aged, 0);
    }

    #[test]
    fn rotates_runtime_by_size_and_day_and_cleans_expired_segments() {
        let profile = Profile::new();
        let mut store = Diagnostics::open(&profile.0).unwrap();
        let at = now().unwrap();
        let retired = store.root.join(format!(
            "runtime-{:013}-{}.jsonl",
            at - AGE_MS - 1,
            Uuid::new_v4()
        ));
        File::create(&retired).unwrap();
        store
            .record_at(observation(Action::Start, Outcome::Success, None), at)
            .unwrap();
        assert!(!retired.exists());
        let active = store.active.as_mut().unwrap();
        let original = active.path.clone();
        OpenOptions::new()
            .write(true)
            .open(&original)
            .unwrap()
            .set_len(FILE_BYTES - 1)
            .unwrap();
        active.bytes = FILE_BYTES - 1;
        store
            .record_at(observation(Action::Exit, Outcome::Success, None), at + 1)
            .unwrap();
        assert_ne!(store.active.as_ref().unwrap().path, original);
        assert_eq!(fs::metadata(original).unwrap().len(), FILE_BYTES - 1);
        for day in 1..=FILE_COUNT as i64 + 1 {
            store
                .record_at(
                    observation(Action::Start, Outcome::Success, None),
                    at + day * DAY_MS,
                )
                .unwrap();
        }
        let retained = store.segments().unwrap();
        assert_eq!(retained.len(), FILE_COUNT);
        assert!(retained.iter().all(|file| file.bytes < FILE_BYTES));
    }
}

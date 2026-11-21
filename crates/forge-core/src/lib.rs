mod assets;
mod checklist;
mod data_links;
pub mod dataset;
pub mod diagnostics;
mod directory;
pub mod editor;
pub mod git;
pub mod intelligent;
mod model;
mod palette;
mod project;
pub mod research;
pub mod scheme;
pub mod settings;
mod site;
mod storage;
mod video;
mod wav;

use std::{error, fmt, io};

pub use assets::{
    AssetFormat, AssetPreview, AssetRef, ImportItem, ImportProgress, ImportRequest, ImportResult,
};
pub use checklist::{ChecklistCompletion, ChecklistGroup, ChecklistItem};
pub use data_links::{DataLink, DataType, GalleryItem, LinkPort};
pub use directory::{DirectoryChange, DirectoryEntry, DirectoryListing, EntryKind};
pub use model::{Change, Content, Group, Node, Placement, Position, Space, Viewport};
pub use project::{
    AnalysisPhase, AssetPage, BackupInfo, ChecklistRecordPage, ComparisonRequest, ComparisonSide,
    EditRequest, EditTextAssetRequest, EditorExportRequest, EditorPreviewRequest, LinkedText,
    MetadataRequest, MetadataSummary, PaletteRequest, PaletteStatus, PaletteSummary, Project,
    ProjectView, ReplaceAssetRequest, ResearchStatus, RevisionEntry, SettingsBackupInfo,
    create_settings_backup, inspect_settings_backup, read_settings_backup,
};
pub use project::{
    PreparedUpdateBackup, RecoveredUpdateBackup, UpdateBackupInfo, UpdateBackupReceipt,
    UpdateBackupScope, UpdateProjectScope, open_update_backup, prepare_update_backup,
};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Invalid(&'static str),
    AlreadyExists,
    Locked,
    StaleRevision {
        current: i64,
    },
    UnsupportedSchema(u32),
    Corrupt(&'static str),
    AssetIntegrity,
    AssetUnavailable,
    ExportExists,
    ImportCanceled,
    AnalysisCanceled,
    Link(&'static str, &'static str),
    DirectoryChanged,
    DirectoryIo(&'static str, i32),
    Git(&'static str, &'static str),
    Dataset {
        line: usize,
        column: Option<usize>,
        message: &'static str,
    },
    Limit,
    Io(io::Error),
    Db(rusqlite::Error),
    Json(serde_json::Error),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "INVALID_INPUT",
            Self::AlreadyExists => "PROJECT_EXISTS",
            Self::Locked => "PROJECT_LOCKED",
            Self::StaleRevision { .. } => "REVISION_CONFLICT",
            Self::UnsupportedSchema(_) => "SCHEMA_UNSUPPORTED",
            Self::Corrupt(_) | Self::Json(_) => "PROJECT_CORRUPT",
            Self::AssetIntegrity => "ASSET_INTEGRITY",
            Self::AssetUnavailable => "ASSET_UNAVAILABLE",
            Self::ExportExists => "EXPORT_EXISTS",
            Self::ImportCanceled => "IMPORT_CANCELED",
            Self::AnalysisCanceled => "CANCELLED",
            Self::Link(code, _) => code,
            Self::DirectoryChanged => "DIRECTORY_CHANGED",
            Self::DirectoryIo(_, _) => "DIRECTORY_IO_ERROR",
            Self::Git(code, _) => code,
            Self::Dataset { .. } => "DATASET_INVALID",
            Self::Limit => "LIMIT_EXCEEDED",
            Self::Io(error) if error.kind() == io::ErrorKind::StorageFull => "STORAGE_FULL",
            Self::Db(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::DiskFull =>
            {
                "STORAGE_FULL"
            }
            Self::Io(_) | Self::Db(_) => "PROJECT_IO_ERROR",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) | Self::Corrupt(message) => write!(f, "{message}"),
            Self::AlreadyExists => write!(f, "Choose an empty folder to create a project"),
            Self::Locked => write!(f, "This project is open in another writer"),
            Self::StaleRevision { current } => write!(f, "Project changed at revision {current}"),
            Self::UnsupportedSchema(version) => write!(f, "Unsupported project schema {version}"),
            Self::AssetIntegrity => write!(f, "The stored file failed its integrity check"),
            Self::AssetUnavailable => write!(f, "This file version is no longer on the card"),
            Self::ExportExists => write!(f, "A file with that name exists. Choose another name"),
            Self::ImportCanceled => write!(f, "Import canceled"),
            Self::AnalysisCanceled => write!(f, "Analysis cancelled"),
            Self::Link(_, message) | Self::Git(_, message) => write!(f, "{message}"),
            Self::DirectoryChanged => {
                write!(f, "This entry changed. Refresh Directory and try again")
            }
            Self::DirectoryIo(message, code) => write!(f, "{message} (Windows error {code})"),
            Self::Dataset {
                line,
                column,
                message,
            } => match (line, column) {
                (0, _) => write!(f, "{message}"),
                (line, Some(column)) => write!(f, "Row {line}, column {column}. {message}"),
                (line, None) => write!(f, "Row {line}. {message}"),
            },
            Self::Limit => write!(f, "Project state exceeds the supported size"),
            Self::Io(_) | Self::Db(_) | Self::Json(_) => write!(f, "{}", self.code()),
        }
    }
}

impl error::Error for Error {}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Db(error)
    }
}
impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

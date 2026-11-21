use crate::settings::{Preferences, SETTINGS_SCHEMA};
use std::io::Cursor;

use super::*;

pub(super) const SETTINGS: &str = "data/settings.json";
const LIMITS: ArchiveLimits = ArchiveLimits {
    zip: 64 * 1024,
    unpacked: 64 * 1024,
    manifest: 8 * 1024,
    entries: 2..=2,
};
const SETTINGS_BYTES: u64 = 4096;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBackupInfo {
    pub source_version: String,
    pub created_at: String,
    pub archive_bytes: u64,
    pub archive_sha256: String,
    pub schema_version: u32,
    pub snap_to_grid: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    schema_version: u32,
    preferences: Preferences,
}

pub fn create_settings_backup(
    destination: &Path,
    preferences: Preferences,
) -> Result<SettingsBackupInfo> {
    let destination = files::absolute_destination(destination)?;
    if !destination
        .extension()
        .and_then(|part| part.to_str())
        .is_some_and(|part| part.eq_ignore_ascii_case("zip"))
    {
        return Err(boundary("Choose a .zip destination"));
    }
    if destination.symlink_metadata().is_ok() {
        return Err(Error::ExportExists);
    }
    let parent = destination.parent().expect("checked destination");
    let bytes = encode(preferences)?;
    let (info, _) = inspect(Cursor::new(bytes.as_slice()), bytes.len() as u64)?;
    files::ensure_space(parent, bytes.len() as u64)?;
    let scratch = files::Scratch::create(parent)?;
    let draft = scratch.path().join("settings.zip");
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&draft)?;
    target.write_all(&bytes)?;
    target.sync_all()?;
    drop(target);
    if inspect_settings_backup(&draft)?.archive_sha256 != info.archive_sha256 {
        return Err(invalid_archive(
            "Written settings archive differs from its verified snapshot",
        ));
    }
    files::publish(&draft, &destination)?;
    Ok(info)
}

fn encode(preferences: Preferences) -> Result<Vec<u8>> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let mut builder = Builder {
        zip: &mut zip,
        bytes: 0,
        limit: LIMITS.zip,
        members: BTreeMap::new(),
    };
    write_snapshot(&mut builder, preferences)?;
    let created_at = Connection::open_in_memory()?.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
        |row| row.get(0),
    )?;
    let manifest = ArchiveManifest {
        format: FORMAT.into(),
        schema_version: VERSION,
        source_version: env!("CARGO_PKG_VERSION").into(),
        source_project_id: None,
        project_schema: None,
        scope: "settings".into(),
        restore_mode: "replace".into(),
        created_at,
        excluded_entries: 0,
        update: None,
        members: builder.members,
    };
    write_manifest(&mut zip, &manifest, LIMITS.manifest)?;
    Ok(zip_result(zip.finish())?.into_inner())
}

pub fn inspect_settings_backup(path: &Path) -> Result<SettingsBackupInfo> {
    let file = files::open_archive(path)?;
    let bytes = file.metadata()?.len();
    Ok(inspect(file, bytes)?.0)
}

pub fn read_settings_backup(path: &Path, expected_sha256: &str) -> Result<Preferences> {
    let file = files::open_archive(path)?;
    let bytes = file.metadata()?.len();
    let (summary, preferences) = inspect(file, bytes)?;
    if summary.archive_sha256 != expected_sha256 {
        return Err(Error::Link(
            "BACKUP_CHANGED",
            "The archive differs from the inspected file",
        ));
    }
    Ok(preferences)
}

fn inspect(file: impl Read + Seek, bytes: u64) -> Result<(SettingsBackupInfo, Preferences)> {
    let Envelope {
        mut zip,
        manifest,
        archive_sha256,
        archive_bytes,
        ..
    } = inspect_envelope(file, bytes, LIMITS, |name| {
        matches!(name, MANIFEST | SETTINGS)
    })?;
    if manifest.scope != "settings"
        || manifest.restore_mode != "replace"
        || manifest.source_project_id.is_some()
        || manifest.project_schema.is_some()
        || manifest.excluded_entries != 0
        || manifest.update.is_some()
    {
        return Err(invalid_archive("Archive has an unsupported settings scope"));
    }
    let preferences = read_snapshot(&mut zip, &manifest.members)?;
    Ok((
        SettingsBackupInfo {
            source_version: manifest.source_version,
            created_at: manifest.created_at,
            archive_bytes,
            archive_sha256,
            schema_version: SETTINGS_SCHEMA,
            snap_to_grid: preferences.snap_to_grid,
        },
        preferences,
    ))
}

pub(super) fn write_snapshot<W: Write + Seek>(
    builder: &mut Builder<'_, W>,
    preferences: Preferences,
) -> Result<()> {
    builder.write(SETTINGS, |writer| {
        serde_json::to_writer(
            writer,
            &Snapshot {
                schema_version: SETTINGS_SCHEMA,
                preferences,
            },
        )?;
        Ok(None)
    })?;
    Ok(())
}

pub(super) fn read_snapshot<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    members: &BTreeMap<String, Member>,
) -> Result<Preferences> {
    let member = members
        .get(SETTINGS)
        .filter(|member| member.records.is_none() && valid_hash(&member.sha256))
        .ok_or_else(|| invalid_archive("Settings archive member is missing or invalid"))?;
    if member.bytes > SETTINGS_BYTES {
        return Err(archive_limit("Settings snapshot exceeds its size limit"));
    }
    let item = zip_result(zip.by_name(SETTINGS))?;
    if item.size() != member.bytes {
        return Err(invalid_archive(
            "Settings member size differs from the manifest",
        ));
    }
    let mut checked = MeasureRead::new(item, member.bytes);
    let mut encoded = Vec::new();
    checked.read_to_end(&mut encoded)?;
    checked.finish(member)?;
    let snapshot: Snapshot = serde_json::from_slice(&encoded)
        .map_err(|_| invalid_archive("Settings data does not match its schema"))?;
    if snapshot.schema_version != SETTINGS_SCHEMA {
        return Err(Error::UnsupportedSchema(snapshot.schema_version));
    }
    Ok(snapshot.preferences)
}

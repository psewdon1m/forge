use std::{fs, path::Path, time::Duration};

use rusqlite::Transaction;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Result, project::is_link};

pub const SETTINGS_SCHEMA: u32 = 1;
pub const MAX_SETTINGS_REVISION: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub snap_to_grid: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    pub revision: i64,
    pub preferences: Preferences,
}

pub struct ProfileSettings {
    db: Connection,
}

pub struct SettingsReplacement<'a> {
    tx: Transaction<'a>,
    revision: i64,
}

impl ProfileSettings {
    pub fn open(profile: &Path) -> Result<Self> {
        if !profile.is_absolute() {
            return Err(Error::Invalid("Choose an absolute Forge profile"));
        }
        fs::create_dir_all(profile)?;
        let root = fs::canonicalize(profile)?;
        let path = root.join("settings.sqlite");
        for existing in [&path, &root.join("settings.sqlite-journal")] {
            match existing.symlink_metadata() {
                Ok(meta) if !meta.is_file() || is_link(&meta) => {
                    return Err(Error::Invalid(
                        "The settings storage path is not a regular file",
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(1))?;
        db.execute_batch("PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL;")?;
        let schema: u32 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match schema {
            0 => db.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS preferences (
                     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                     revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
                     snap_to_grid INTEGER NOT NULL CHECK (snap_to_grid IN (0, 1))
                 ) STRICT;
                 INSERT OR IGNORE INTO preferences VALUES (1, 0, 1);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )?,
            SETTINGS_SCHEMA => {}
            unsupported => return Err(Error::UnsupportedSchema(unsupported)),
        }
        let store = Self { db };
        store.read()?;
        Ok(store)
    }

    pub fn read(&self) -> Result<SettingsState> {
        read(&self.db)
    }

    /// Pins the validated preference revision while a signed runtime is being started.
    pub fn lock_revision(&mut self, expected_revision: i64) -> Result<impl Drop + '_> {
        Ok(self.snapshot_lock(expected_revision)?.0)
    }

    pub(crate) fn snapshot_lock(
        &mut self,
        expected_revision: i64,
    ) -> Result<(Transaction<'_>, SettingsState)> {
        let lock = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = read(&lock)?;
        if state.revision != expected_revision {
            return Err(Error::Link(
                "SETTINGS_CHANGED",
                "The settings changed before preparing the update backup",
            ));
        }
        Ok((lock, state))
    }

    pub fn replace(
        &mut self,
        expected_revision: i64,
        preferences: Preferences,
    ) -> Result<SettingsState> {
        self.begin_replacement(expected_revision)?
            .commit(preferences, None)
    }

    pub fn begin_replacement(&mut self, expected_revision: i64) -> Result<SettingsReplacement<'_>> {
        let (tx, state) = self
            .snapshot_lock(expected_revision)
            .map_err(|error| match error {
                Error::Link("SETTINGS_CHANGED", _) => Error::Link(
                    "SETTINGS_CHANGED",
                    "The settings changed. Refresh them before trying again.",
                ),
                error => error,
            })?;
        Ok(SettingsReplacement {
            tx,
            revision: state.revision,
        })
    }
}

impl SettingsReplacement<'_> {
    /// This receipt is committed in the same SQLite transaction as the restored preferences.
    pub fn restore_for_update(self, preferences: Preferences, job: Uuid) -> Result<SettingsState> {
        if job.is_nil() {
            return Err(Error::Invalid("Invalid settings recovery job"));
        }
        self.commit(preferences, Some(job))
    }

    pub fn restored_revision(&self, job: Uuid) -> Result<Option<i64>> {
        let present = self.tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'update_settings_recovery' AND type = 'table')",
            [], |row| row.get::<_, bool>(0),
        )?;
        if !present {
            return Ok(None);
        }
        Ok(self
            .tx
            .query_row(
                "SELECT revision FROM update_settings_recovery WHERE singleton = 1 AND job_id = ?1",
                [job.to_string()],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn commit(self, preferences: Preferences, job: Option<Uuid>) -> Result<SettingsState> {
        let changed = self.tx.execute(
            "UPDATE preferences SET revision = revision + 1, snap_to_grid = ?1
             WHERE singleton = 1 AND revision = ?2",
            params![preferences.snap_to_grid, self.revision],
        )?;
        if changed != 1 {
            return Err(Error::Link(
                "SETTINGS_CHANGED",
                "The settings changed. Refresh them before trying again.",
            ));
        }
        let state = read(&self.tx)?;
        if let Some(job) = job {
            self.tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS update_settings_recovery (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    job_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK (revision > 0)
                 ) STRICT;",
            )?;
            self.tx.execute(
                "INSERT INTO update_settings_recovery (singleton, job_id, revision) VALUES (1, ?1, ?2)
                 ON CONFLICT (singleton) DO UPDATE SET job_id = excluded.job_id, revision = excluded.revision",
                params![job.to_string(), state.revision],
            )?;
        }
        self.tx.commit()?;
        Ok(state)
    }
}

fn read(db: &Connection) -> Result<SettingsState> {
    Ok(db.query_row(
        "SELECT revision, snap_to_grid FROM preferences WHERE singleton = 1",
        [],
        |row| {
            Ok(SettingsState {
                revision: row.get(0)?,
                preferences: Preferences {
                    snap_to_grid: row.get(1)?,
                },
            })
        },
    )?)
}

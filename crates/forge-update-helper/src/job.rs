use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions, TryLockError},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use forge_core::{
    Error as CoreError, UpdateBackupReceipt, UpdateBackupScope,
    diagnostics::{UpdateHttpFailure, UpdateJobPhase},
    open_update_backup, prepare_update_backup,
    settings::{MAX_SETTINGS_REVISION, ProfileSettings},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    Result, bundle,
    discovery::{self, AssetHttpFailure, ChannelProblem, DownloadFailure, Https},
    install::{self, Active},
    manifest::{canonical, lower_hex, stable_version},
    open_with_sharing, startup,
};

mod manual;
pub use manual::rollback_manual;

const JOURNAL: &str = "update-job.json";
const JOURNAL_LIMIT: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageRequest {
    version: String,
    package_sha256: String,
    backup_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateRequest {
    id: Uuid,
    pid: u32,
    backup_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Preparing,
    BackupSaved,
    Downloading,
    Verifying,
    Staged,
    Failed,
    Starting,
    Committing,
    Healthy,
    RollingBack,
    RolledBack,
    ManualStarting,
    ManualCommitting,
    ManualRolledBack,
    RecoveryRequired,
}

impl Phase {
    fn has_slot(self) -> bool {
        matches!(
            self,
            Self::Staged
                | Self::Starting
                | Self::Committing
                | Self::Healthy
                | Self::RollingBack
                | Self::RolledBack
                | Self::ManualStarting
                | Self::ManualCommitting
                | Self::ManualRolledBack
                | Self::RecoveryRequired
        )
    }

    fn has_failure(self) -> bool {
        matches!(
            self,
            Self::Failed | Self::RollingBack | Self::RolledBack | Self::RecoveryRequired
        )
    }

    fn manual_pending(self) -> bool {
        matches!(self, Self::ManualStarting | Self::ManualCommitting)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Issue {
    Backup,
    BackupStorageFull,
    DestinationExists,
    BackupChanged,
    Download,
    Verification,
    Storage,
    AppExit,
    CandidateHealth,
    PreviousHealth,
    ActivationInterrupted,
    ManualPreviousHealth,
    ManualInterrupted,
    ManualStorage,
    ManualInconsistent,
}

impl Issue {
    fn message(self) -> &'static str {
        match self {
            Self::Backup => {
                "Forge could not create a complete update backup. Check the destination and free space."
            }
            Self::BackupStorageFull => {
                "The backup volume has insufficient free space. Choose a different destination."
            }
            Self::DestinationExists => "The backup name already exists. Choose a new ZIP file.",
            Self::BackupChanged => "The saved backup changed or expired. Create a new backup.",
            Self::Download => {
                "Forge could not download the complete signed package. Check the connection and free space."
            }
            Self::Verification => {
                "The update package failed integrity or package identity verification."
            }
            Self::Storage => {
                "Forge could not persist update preparation. Check the installation volume."
            }
            Self::AppExit => {
                "Forge did not close before the restart deadline. Close the app and try again."
            }
            Self::CandidateHealth => "The new version did not pass its startup checks.",
            Self::PreviousHealth => "The previous version could not be verified or started.",
            Self::ActivationInterrupted => "The updater stopped before confirming the change.",
            Self::ManualPreviousHealth => {
                "The previous version could not start. The update remains installed."
            }
            Self::ManualInterrupted => {
                "The manual rollback stopped before restoring settings. The update remains installed."
            }
            Self::ManualStorage => {
                "Forge could not finish writing the rollback state. Check the installation volume."
            }
            Self::ManualInconsistent => {
                "Forge could not match the saved job to the settings revision and active slot."
            }
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    schema_version: u32,
    id: Uuid,
    previous: Active,
    target_version: String,
    target_sha256: String,
    phase: Phase,
    backup: Option<UpdateBackupReceipt>,
    candidate: Option<Active>,
    issue: Option<Issue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    download_http_error: Option<AssetHttpFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_issue: Option<Issue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manual_revision: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    id: Uuid,
    source_version: String,
    target_version: String,
    target_package_sha256: String,
    phase: UpdateJobPhase,
    message: Option<String>,
    recovery_message: Option<&'static str>,
    can_roll_back: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_http_error: Option<UpdateHttpFailure>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum StageReply {
    Job(JobSummary),
    Rejected { rejection: ChannelProblem },
}

impl Job {
    fn check(&self) -> Result<()> {
        self.previous.check()?;
        if self.schema_version != 1
            || self.id.is_nil()
            || self.previous.slot == self.id.to_string()
            || stable_version(&self.target_version)? <= stable_version(&self.previous.version)?
            || !lower_hex(&self.target_sha256, 64)
            || (self.phase.has_failure() != self.issue.is_some()
                && !matches!(
                    (self.phase, self.issue),
                    (Phase::Staged | Phase::Healthy, Some(Issue::AppExit))
                        | (
                            Phase::Healthy,
                            Some(
                                Issue::ManualPreviousHealth
                                    | Issue::ManualInterrupted
                                    | Issue::ManualStorage
                            )
                        )
                ))
            || (self.phase == Phase::RecoveryRequired) != self.recovery_issue.is_some()
            || self.download_http_error.is_some_and(|error| {
                !error.valid()
                    || !matches!(
                        (self.phase, self.issue),
                        (Phase::Failed, Some(Issue::Download))
                    )
            })
            || self.phase.has_slot() != self.candidate.is_some()
            || ((self.phase.has_slot()
                || matches!(
                    self.phase,
                    Phase::BackupSaved | Phase::Downloading | Phase::Verifying
                ))
                && self.backup.is_none())
            || (self.phase.manual_pending() && self.manual_revision.is_none())
            || self.manual_revision.is_some_and(|revision| {
                !(0..MAX_SETTINGS_REVISION).contains(&revision)
                    || !(self.phase.manual_pending() || self.phase == Phase::RecoveryRequired)
            })
        {
            return Err("Invalid update job record".into());
        }
        if let Some(backup) = &self.backup
            && (backup.info.job_id() != self.id
                || backup.info.target()
                    != (self.target_version.as_str(), self.target_sha256.as_str())
                || backup.info.source_version != self.previous.version
                || !backup.info.projects().is_empty()
                || backup.info.settings_revision() < 0
                || backup.info.archive_bytes == 0
                || backup.info.archive_bytes > 128 * 1024 * 1024
                || !lower_hex(&backup.info.archive_sha256, 64))
        {
            return Err("The job backup receipt has a different scope".into());
        }
        if let Some(slot) = &self.candidate {
            slot.check()?;
            if slot.slot != self.id.to_string()
                || slot.version != self.target_version
                || slot.package_sha256 != self.target_sha256
            {
                return Err("The staged slot does not match the job".into());
            }
        }
        Ok(())
    }

    fn write(&self, root: &Path) -> Result<()> {
        self.check()?;
        install::replace_record(root, JOURNAL, &canonical(self)?)
    }

    fn active(&self) -> bool {
        !matches!(
            self.phase,
            Phase::Staged
                | Phase::Failed
                | Phase::Healthy
                | Phase::RolledBack
                | Phase::ManualRolledBack
                | Phase::RecoveryRequired
        )
    }

    fn summary(&self, interrupted: bool, can_roll_back: bool) -> JobSummary {
        let phase = if interrupted && !self.phase.has_slot() {
            UpdateJobPhase::Interrupted
        } else {
            match self.phase {
                Phase::Preparing => UpdateJobPhase::Preparing,
                Phase::BackupSaved => UpdateJobPhase::BackupSaved,
                Phase::Downloading => UpdateJobPhase::Downloading,
                Phase::Verifying => UpdateJobPhase::Verifying,
                Phase::Staged => UpdateJobPhase::Staged,
                Phase::Failed => UpdateJobPhase::Failed,
                Phase::Starting | Phase::Committing => UpdateJobPhase::Starting,
                Phase::Healthy => UpdateJobPhase::Healthy,
                Phase::RollingBack => UpdateJobPhase::RollingBack,
                Phase::RolledBack => UpdateJobPhase::RolledBack,
                Phase::ManualStarting | Phase::ManualCommitting => {
                    UpdateJobPhase::ManualRollingBack
                }
                Phase::ManualRolledBack => UpdateJobPhase::ManualRolledBack,
                Phase::RecoveryRequired => UpdateJobPhase::RecoveryRequired,
            }
        };
        JobSummary {
            id: self.id,
            source_version: self.previous.version.clone(),
            target_version: self.target_version.clone(),
            target_package_sha256: self.target_sha256.clone(),
            phase,
            message: if phase == UpdateJobPhase::Interrupted {
                Some("Update preparation was interrupted. The active version is available.".into())
            } else if let Some(error) = self.download_http_error {
                Some(error.message())
            } else {
                self.issue.map(|issue| issue.message().into())
            },
            recovery_message: self.recovery_issue.map(Issue::message),
            can_roll_back,
            download_http_error: self.download_http_error.map(AssetHttpFailure::diagnostic),
        }
    }
}

fn read(root: &Path) -> Result<Option<Job>> {
    let path = root.join(JOURNAL);
    match path.symlink_metadata() {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut bytes = Vec::new();
    open_with_sharing(&path, true)?
        .take(JOURNAL_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > JOURNAL_LIMIT {
        return Err("Update job record exceeds its size limit".into());
    }
    let job: Job = serde_json::from_slice(&bytes)?;
    job.check()?;
    Ok(Some(job))
}

pub(crate) fn summary(root: &Path, installed: &Active) -> Result<Option<JobSummary>> {
    let Some(mut job) = read(root)? else {
        return Ok(None);
    };
    let interrupted = if job.active() {
        match install::acquire(root) {
            Ok(_guard) => {
                job = read(root)?.ok_or("The update job record was removed")?;
                job.active()
            }
            Err(error)
                if matches!(
                    error.downcast_ref::<TryLockError>(),
                    Some(TryLockError::WouldBlock)
                ) =>
            {
                false
            }
            Err(error) => return Err(error),
        }
    } else {
        false
    };
    let can_roll_back = job.phase == Phase::Healthy
        && job.candidate.as_ref() == Some(installed)
        && install::verified_slot(root, &job.previous).is_ok();
    Ok(Some(job.summary(interrupted, can_roll_back)))
}

fn archive_path(root: &Path, id: Uuid) -> PathBuf {
    root.join(format!("download-{id}.zip.part"))
}

pub fn stage(root: &Path, request: StageRequest) -> Result<StageReply> {
    let (previous, _) = discovery::verified_helper(root)?;
    let _guard =
        install::acquire(root).map_err(|_| "Another update operation may already be running")?;
    let (current, trust) = discovery::verified_helper(root)?;
    if current != previous {
        return Err("The active version changed before the update started".into());
    }
    let last = read(root)?;
    if last.as_ref().is_some_and(|last| {
        matches!(
            last.phase,
            Phase::Staged
                | Phase::Starting
                | Phase::Committing
                | Phase::RollingBack
                | Phase::RecoveryRequired
        ) || last.phase.manual_pending()
    }) {
        return Err("Finish the existing update before preparing another".into());
    }
    let signed = match discovery::staging_manifest(
        trust,
        &current,
        &request.version,
        &request.package_sha256,
    ) {
        Ok(signed) => signed,
        Err(failure) => {
            return Ok(StageReply::Rejected {
                rejection: failure.problem(),
            });
        }
    };
    if let Some(last) = last {
        let _ = fs::remove_file(archive_path(root, last.id));
    }
    let mut job = Job {
        schema_version: 1,
        id: Uuid::new_v4(),
        previous,
        target_version: request.version,
        target_sha256: request.package_sha256,
        phase: Phase::Preparing,
        backup: None,
        candidate: None,
        issue: None,
        download_http_error: None,
        recovery_issue: None,
        manual_revision: None,
    };
    job.write(root)?;
    let package = archive_path(root, job.id);
    let result = prepare(root, &request.backup_path, &package, &signed, &mut job);
    let _ = fs::remove_file(package);
    if let Err(issue) = result {
        job.phase = Phase::Failed;
        job.candidate = None;
        job.issue = Some(issue);
        job.write(root)?;
    }
    Ok(StageReply::Job(job.summary(false, false)))
}

pub fn activate(root: &Path, request: ActivateRequest) -> Result<()> {
    let _guard = install::acquire(root)?;
    let mut job = read(root)?.ok_or("No update is ready to start")?;
    if job.phase != Phase::Staged
        || job.id != request.id
        || install::active_record(root)? != job.previous
    {
        return Err("The prepared update or active version has changed".into());
    }
    let receipt = job
        .backup
        .as_ref()
        .ok_or("The staged update has no backup receipt")?;
    if receipt.check_install_age().is_err() {
        return invalidate_preparation(root, job);
    }
    if !request.backup_path.is_absolute() {
        return Err("Choose the saved update backup ZIP".into());
    }
    let settings_revision = receipt.info.settings_revision();
    let _backup = open_update_backup(&request.backup_path, receipt)?;
    let (previous_path, _) = install::verified_slot(root, &job.previous)?;
    let source = startup::SourceProcess::open(request.pid, &previous_path.join("Forge.exe"))?;
    let mut settings = profile(root)?;
    let write_guard = match settings.lock_revision(settings_revision) {
        Ok(guard) => guard,
        Err(CoreError::Link("SETTINGS_CHANGED", _)) => return invalidate_preparation(root, job),
        Err(error) => return Err(error.into()),
    };
    // Flush the handoff before waiting. The desktop quits only after receiving this acknowledgment.
    acknowledge(job.id)?;
    if source.wait().is_err() {
        job.issue = Some(Issue::AppExit);
        return job.write(root);
    }
    job.phase = Phase::Starting;
    job.issue = None;
    job.write(root)?;
    let result = start_candidate(root, &mut job);
    // All live data uses the current schema. The guard pins preferences through the health decision.
    drop(write_guard);
    if result.and_then(startup::Healthy::release).is_err() {
        let issue = if job.phase == Phase::Starting {
            Issue::CandidateHealth
        } else {
            Issue::Storage
        };
        roll_back(root, &mut job, issue)?;
    }
    Ok(())
}

fn acknowledge(id: Uuid) -> Result<()> {
    writeln!(io::stdout(), "{id}")?;
    io::stdout().flush()?;
    Ok(())
}

fn invalidate_preparation(root: &Path, mut job: Job) -> Result<()> {
    job.phase = Phase::Failed;
    job.issue = Some(Issue::BackupChanged);
    job.candidate = None;
    job.write(root)?;
    Err("Create a fresh update backup before restarting".into())
}

fn start_candidate(root: &Path, job: &mut Job) -> Result<startup::Healthy> {
    let candidate = job
        .candidate
        .as_ref()
        .ok_or("The candidate slot is missing")?;
    let (path, _) = install::verified_slot(root, candidate)?;
    let healthy = startup::check(root, &path, job.id, &candidate.version)?;
    job.phase = Phase::Committing;
    job.write(root)?;
    install::replace_active(root, &job.previous, candidate)?;
    job.phase = Phase::Healthy;
    job.write(root)?;
    Ok(healthy)
}

fn roll_back(root: &Path, job: &mut Job, issue: Issue) -> Result<()> {
    job.phase = Phase::RollingBack;
    job.issue = Some(issue);
    job.write(root)?;
    let result = (|| -> Result<()> {
        let (path, _) = install::verified_slot(root, &job.previous)?;
        let active = install::active_record(root)?;
        if active != job.previous {
            if job.candidate.as_ref() != Some(&active) {
                return Err("The current slot is unrelated to this update".into());
            }
            install::replace_active(root, &active, &job.previous)?;
        }
        let healthy = startup::check(root, &path, job.id, &job.previous.version)?;
        job.phase = Phase::RolledBack;
        job.write(root)?;
        healthy.release()
    })();
    if result.is_err() {
        job.phase = Phase::RecoveryRequired;
        job.recovery_issue = Some(Issue::PreviousHealth);
        job.write(root)?;
        return Err(
            "Automatic rollback needs recovery. See the update job in the installation directory."
                .into(),
        );
    }
    Ok(())
}

pub fn launch(root: &Path) -> Result<()> {
    let _guard = install::acquire(root)?;
    if let Some(mut job) = read(root)? {
        let phase = job.phase;
        if phase.manual_pending() {
            return manual::reconcile(root, job, Issue::ManualInterrupted);
        }
        if matches!(
            phase,
            Phase::Starting | Phase::Committing | Phase::RollingBack
        ) {
            let issue = job.issue.unwrap_or(Issue::ActivationInterrupted);
            return roll_back(root, &mut job, issue);
        }
        if phase == Phase::RecoveryRequired {
            return Err(
                "Forge needs recovery. See the update job in the installation directory.".into(),
            );
        }
    }
    install::launch_active(root)
}

fn profile(root: &Path) -> Result<ProfileSettings> {
    Ok(ProfileSettings::open(
        &root
            .parent()
            .ok_or("Invalid profile directory")?
            .join("Profile"),
    )?)
}

fn prepare(
    root: &Path,
    destination: &Path,
    package: &Path,
    release: &crate::manifest::VerifiedManifest,
    job: &mut Job,
) -> std::result::Result<(), Issue> {
    let profile = root.parent().ok_or(Issue::Backup)?.join("Profile");
    let mut settings = ProfileSettings::open(&profile).map_err(|_| Issue::Backup)?;
    let settings_revision = settings.read().map_err(|_| Issue::Backup)?.revision;
    let scope = UpdateBackupScope {
        job_id: job.id,
        target_version: job.target_version.clone(),
        target_sha256: job.target_sha256.clone(),
        settings_revision,
        projects: BTreeMap::new(),
    };
    let mut prepared =
        prepare_update_backup(&mut settings, scope, Vec::new()).map_err(|_| Issue::Backup)?;
    let receipt = prepared
        .save(destination)
        .map_err(|error| match error.code() {
            "EXPORT_EXISTS" => Issue::DestinationExists,
            "STORAGE_FULL" => Issue::BackupStorageFull,
            _ => Issue::Backup,
        })?;
    prepared
        .for_install(&receipt)
        .map_err(|_| Issue::BackupChanged)?;
    job.backup = Some(receipt.clone());
    job.phase = Phase::BackupSaved;
    job.write(root).map_err(|_| Issue::Storage)?;
    job.phase = Phase::Downloading;
    job.write(root).map_err(|_| Issue::Storage)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(package)
        .map_err(|_| Issue::Storage)?;
    Https::download(release, &mut file).map_err(|error| {
        if let DownloadFailure::Http(failure) = error {
            job.download_http_error = Some(failure);
        }
        Issue::Download
    })?;
    drop(file);
    job.phase = Phase::Verifying;
    job.write(root).map_err(|_| Issue::Storage)?;
    let verified = bundle::verified_file(package, release).map_err(|_| Issue::Verification)?;
    prepared
        .for_install(&receipt)
        .map_err(|_| Issue::BackupChanged)?;
    job.candidate = Some(
        install::stage_slot(root, verified, release, job.id, None)
            .map_err(|_| Issue::Verification)?,
    );
    prepared
        .for_install(&receipt)
        .map_err(|_| Issue::BackupChanged)?;
    job.phase = Phase::Staged;
    job.write(root).map_err(|_| Issue::Storage)
}

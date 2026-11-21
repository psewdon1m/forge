use super::{
    ActivateRequest, Issue, Job, MAX_SETTINGS_REVISION, Phase, Result, install, open_update_backup,
    profile, read, startup,
};
use std::{io::Write, path::Path};

pub fn rollback_manual(root: &Path, request: ActivateRequest) -> Result<()> {
    let _guard = install::acquire(root)?;
    let mut job = read(root)?.ok_or("No completed update is available to roll back")?;
    let active = install::active_record(root)?;
    if job.phase != Phase::Healthy
        || job.id != request.id
        || job.candidate.as_ref() != Some(&active)
    {
        return Err("The installed version does not match the selected update job".into());
    }
    let (current_path, _) = install::verified_slot(root, &active)?;
    let (previous_path, _) = install::verified_slot(root, &job.previous)?;
    let receipt = job
        .backup
        .as_ref()
        .ok_or("The completed update has no backup receipt")?;
    if !request.backup_path.is_absolute()
        || request
            .backup_path
            .extension()
            .is_none_or(|suffix| !suffix.eq_ignore_ascii_case("zip"))
    {
        return invalid_backup();
    }
    let preferences = match open_update_backup(&request.backup_path, receipt) {
        Ok(archive) => archive.preferences(),
        Err(_) => return invalid_backup(),
    };
    let source = startup::SourceProcess::open(request.pid, &current_path.join("Forge.exe"))?;
    let mut settings = profile(root)?;
    let revision = settings.read()?.revision;
    if revision >= MAX_SETTINGS_REVISION {
        return Err("The settings revision cannot be incremented".into());
    }
    let writer = settings.begin_replacement(revision)?;
    if writer.restored_revision(job.id)?.is_some() {
        return Err("This update backup has already been applied".into());
    }
    super::acknowledge(job.id)?;
    if source.wait().is_err() {
        job.issue = Some(Issue::AppExit);
        return job.write(root);
    }

    job.phase = Phase::ManualStarting;
    job.manual_revision = Some(revision);
    job.issue = None;
    job.write(root)?;
    let healthy = match startup::check(root, &previous_path, job.id, &job.previous.version) {
        Ok(process) => process,
        Err(_) => {
            drop(writer);
            return reconcile(root, job, Issue::ManualPreviousHealth);
        }
    };

    job.phase = Phase::ManualCommitting;
    job.write(root)?;
    #[cfg(feature = "qualification-discovery")]
    interrupt_test("before-settings-commit");
    let committed = writer.restore_for_update(preferences, job.id);
    #[cfg(feature = "qualification-discovery")]
    if committed.is_ok() {
        interrupt_test("after-settings-commit");
    }
    if committed.is_err() || install::replace_active(root, &active, &job.previous).is_err() {
        drop(healthy);
        return reconcile(root, job, Issue::ManualStorage);
    }
    finish(root, job, healthy, true, Issue::ManualStorage)
}

// Release builds omit this branch. Qualification uses process exit to exercise on-disk recovery.
#[cfg(feature = "qualification-discovery")]
fn interrupt_test(checkpoint: &str) {
    if std::env::var("FORGE_TEST_MANUAL_ROLLBACK_EXIT").as_deref() == Ok(checkpoint) {
        std::process::exit(73);
    }
}

fn invalid_backup() -> Result<()> {
    writeln!(std::io::stdout(), "ROLLBACK_BACKUP_INVALID")?;
    std::io::stdout().flush()?;
    Err("Select the original ZIP saved for this update".into())
}

pub(super) fn reconcile(root: &Path, job: Job, cause: Issue) -> Result<()> {
    let recover = || -> std::result::Result<_, Issue> {
        let before = job.manual_revision.ok_or(Issue::ManualInconsistent)?;
        let mut settings = profile(root).map_err(|_| Issue::ManualInconsistent)?;
        let current = settings
            .read()
            .map_err(|_| Issue::ManualInconsistent)?
            .revision;
        let guard = settings
            .begin_replacement(current)
            .map_err(|_| Issue::ManualInconsistent)?;
        let receipt = guard
            .restored_revision(job.id)
            .map_err(|_| Issue::ManualInconsistent)?;
        let committed = settings_were_restored(job.phase, before, current, receipt)?;
        let candidate = job.candidate.as_ref().ok_or(Issue::ManualInconsistent)?;
        let active = install::active_record(root).map_err(|_| Issue::ManualInconsistent)?;
        // The current renderer was closed before this journal phase. Only these two release identities may be used.
        if active != *candidate && (!committed || active != job.previous) {
            return Err(Issue::ManualInconsistent);
        }
        let target = if committed { &job.previous } else { candidate };
        let failure = if committed {
            Issue::PreviousHealth
        } else {
            Issue::CandidateHealth
        };
        let (path, _) = install::verified_slot(root, target).map_err(|_| failure)?;
        let healthy = startup::check(root, &path, job.id, &target.version).map_err(|_| failure)?;
        if active != *target {
            install::replace_active(root, &active, target).map_err(|_| Issue::ManualStorage)?;
        }
        drop(guard);
        Ok((healthy, committed))
    };
    match recover() {
        Ok((healthy, committed)) => finish(root, job, healthy, committed, cause),
        Err(failure) => require_recovery(root, job, cause, failure),
    }
}

fn settings_were_restored(
    phase: Phase,
    before: i64,
    current: i64,
    receipt: Option<i64>,
) -> std::result::Result<bool, Issue> {
    match (phase, receipt) {
        (Phase::ManualStarting | Phase::ManualCommitting, None) if current == before => Ok(false),
        (Phase::ManualCommitting, Some(revision))
            if revision == before + 1 && current == revision =>
        {
            Ok(true)
        }
        _ => Err(Issue::ManualInconsistent),
    }
}

fn finish(
    root: &Path,
    mut job: Job,
    healthy: startup::Healthy,
    committed: bool,
    cause: Issue,
) -> Result<()> {
    let before = job.manual_revision.take();
    job.phase = if committed {
        Phase::ManualRolledBack
    } else {
        Phase::Healthy
    };
    job.issue = if committed { None } else { Some(cause) };
    job.write(root)?;
    if healthy.release().is_err() {
        job.manual_revision = before;
        let failure = if committed {
            Issue::PreviousHealth
        } else {
            Issue::CandidateHealth
        };
        return require_recovery(root, job, cause, failure);
    }
    Ok(())
}

fn require_recovery(root: &Path, mut job: Job, cause: Issue, failure: Issue) -> Result<()> {
    job.phase = Phase::RecoveryRequired;
    job.issue = Some(cause);
    job.recovery_issue = Some(failure);
    job.write(root)?;
    Err("Manual rollback needs recovery. See the update job in the installation directory.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_commit_must_be_proven_for_the_interrupted_job() {
        assert!(!settings_were_restored(Phase::ManualStarting, 7, 7, None).unwrap());
        assert!(!settings_were_restored(Phase::ManualCommitting, 7, 7, None).unwrap());
        assert!(settings_were_restored(Phase::ManualCommitting, 7, 8, Some(8)).unwrap());
        assert!(settings_were_restored(Phase::ManualStarting, 7, 8, Some(8)).is_err());
        assert!(settings_were_restored(Phase::ManualCommitting, 7, 8, None).is_err());
        assert!(settings_were_restored(Phase::ManualCommitting, 7, 9, Some(8)).is_err());
        assert!(settings_were_restored(Phase::ManualCommitting, 7, 8, Some(7)).is_err());
    }
}

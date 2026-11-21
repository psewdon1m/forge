import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, Settings2 } from 'lucide-react';
import type { UpdateJob, UpdateSelection, UpdateStatus } from './project-api';

type Props = { version?: string; busy: boolean; hasProject: boolean };

const jobLabel: Record<UpdateJob['phase'], string> = {
  preparing: 'Creating update backup…',
  backupSaved: 'Backup saved',
  downloading: 'Downloading update…',
  verifying: 'Verifying and preparing update…',
  staged: 'Update prepared',
  failed: 'Preparation failed',
  interrupted: 'Preparation interrupted',
  starting: 'Checking startup…',
  healthy: 'Update installed',
  rollingBack: 'Returning to the previous version…',
  rolledBack: 'Previous version restored',
  manualRollingBack: 'Restoring the previous version…',
  manualRolledBack: 'Rollback complete',
  recoveryRequired: 'Recovery required',
};

function jobInProgress(job?: UpdateJob | null) {
  return Boolean(job && ['preparing', 'backupSaved', 'downloading', 'verifying', 'starting', 'rollingBack', 'manualRollingBack'].includes(job.phase));
}

function statusText(status: UpdateStatus) {
  switch (status.state) {
    case 'ready': return 'Ready to check';
    case 'upToDate': return 'Up to date';
    case 'available': return 'Update available';
    case 'incompatible': return 'Incompatible';
    case 'offline': return 'Offline';
    case 'error': return 'Error';
    case 'unavailable': return 'Updater unavailable';
  }
}

function UpdateConfirmation({ title, description, onCancel, children }: {
  title: string; description: string; onCancel(): void; children: ReactNode;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    dialog.showModal();
    cancel.current?.focus();
    return () => dialog.close();
  }, []);

  return <dialog ref={element} className="update-confirmation" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => {
    event.preventDefault();
    onCancel();
  }}>
    <h3 id={titleId}>{title}</h3>
    <div className="update-confirmation-body" tabIndex={-1}>
      <p id={descriptionId}>{description}</p>
      <div className="update-confirmation-actions">
        <button ref={cancel} onClick={onCancel}>Cancel</button>
        {children}
      </div>
    </div>
  </dialog>;
}

export function UpdateSettings({ version, busy, hasProject }: Props) {
  const updates = window.forge?.updates;
  const [status, setStatus] = useState<UpdateStatus>();
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date>();
  const [selection, setSelection] = useState<UpdateSelection>();
  const [rollback, setRollback] = useState<UpdateJob>();
  const [job, setJob] = useState<UpdateJob | null>();
  const [staging, setStaging] = useState(false);
  const [problem, setProblem] = useState<{ message: string; correlationId?: string }>();
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const installAction = useRef<HTMLButtonElement>(null);
  const rollbackAction = useRef<HTMLButtonElement>(null);
  const continueAction = useRef<HTMLButtonElement>(null);
  const focusAfterOperation = useRef<'install' | 'rollback' | 'projectBackup' | null>(null);
  const following = staging || jobInProgress(job);
  const unavailable = { state: 'unavailable' as const, installedVersion: version ?? '',
    message: 'The updater is unavailable. Open Forge through its installed launcher.' };

  useEffect(() => {
    if (!updates) {
      setStatus(unavailable);
      return;
    }
    let mounted = true;
    void updates.status().then(reply => {
      if (!mounted) return;
      setStatus(reply.ok ? reply.value : unavailable);
      if (reply.ok) setJob(reply.value.lastJob);
    }).catch(() => {
      if (mounted) setStatus(unavailable);
    });
    return () => { mounted = false; };
  }, [updates, version]);

  useEffect(() => {
    if (!updates || !following) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!updates || !mounted) return;
      try {
        const reply = await updates.status();
        if (mounted && reply.ok && reply.value.state !== 'unavailable') setJob(reply.value.lastJob);
      } catch {
        // The next poll can read the durable job once the helper is available.
      }
      if (mounted) timer = setTimeout(refresh, 750);
    }
    timer = setTimeout(refresh, 750);
    return () => { mounted = false; clearTimeout(timer); };
  }, [updates, following]);

  useLayoutEffect(() => {
    const destination = focusAfterOperation.current;
    if (!destination || selection || rollback || following) return;
    focusAfterOperation.current = null;
    if (destination === 'projectBackup') {
      (document.getElementById('export-project-backup') ?? sectionHeading.current)?.focus();
      return;
    }
    if (document.activeElement !== document.body) return;
    const action = destination === 'install' ? continueAction.current ?? installAction.current : rollbackAction.current;
    (action && !action.disabled ? action : sectionHeading.current)?.focus();
  }, [following, rollback, selection]);

  async function check() {
    if (!updates || checking || following || !status || status.state === 'unavailable') return;
    setSelection(undefined);
    setRollback(undefined);
    setProblem(undefined);
    setChecking(true);
    try {
      const reply = await updates.check();
      setStatus(reply.ok ? reply.value : unavailable);
      if (reply.ok) setJob(reply.value.lastJob);
    } catch {
      setStatus(unavailable);
    } finally {
      setCheckedAt(new Date());
      setChecking(false);
    }
  }

  async function stage() {
    if (!updates || !selection || following || busy) return;
    setSelection(undefined);
    setStaging(true);
    setProblem(undefined);
    try {
      const reply = await updates.stage(selection);
      if (reply.ok) {
        if (reply.value) setJob(reply.value);
      } else {
        setProblem(reply.error);
        if (reply.error.code === 'UPDATE_METADATA_REJECTED') {
          setStatus(current => current?.state === 'available'
            ? { state: 'ready', installedVersion: current.installedVersion }
            : current);
        }
      }
    } catch {
      setProblem({ message: 'Forge could not confirm preparation. Check for updates and try again.' });
    } finally {
      focusAfterOperation.current = 'install';
      setStaging(false);
    }
  }

  async function restart(selection: UpdateJob, restore: boolean) {
    if (!updates || following || busy) return;
    if (job?.id !== selection.id || (restore ? !job.canRollBack : job.phase !== 'staged')) return;
    setRollback(undefined);
    setStaging(true);
    setProblem(undefined);
    try {
      const reply = restore ? await updates.rollback(selection.id) : await updates.restart(selection.id);
      if (!reply.ok) setProblem(reply.error);
    } catch {
      setProblem({ message: 'Forge could not restart. Check the current update job and try again.' });
    } finally {
      const reply = await updates.status().catch(() => undefined);
      if (reply?.ok && reply.value.state !== 'unavailable') setJob(reply.value.lastJob);
      focusAfterOperation.current = restore ? 'rollback' : 'install';
      setStaging(false);
    }
  }

  const heading = checking ? 'Checking…' : status ? statusText(status) : 'Reading updater status…';
  const message = checking ? '' : status?.state === 'error' || status?.state === 'unavailable' ? status.message
    : status?.state === 'offline' ? 'The release source could not be reached. Check the connection and retry.'
    : status?.state === 'incompatible' ? `Forge ${status.version} requires a different Windows, updater or project schema version.`
    : '';
  return <section className="panel updates-panel" aria-label="Updates">
    <h2 ref={sectionHeading} tabIndex={-1}><Settings2 size={17} aria-hidden="true" /> Updates</h2>
    <dl className="updates-facts">
      <div><dt>Installed version</dt><dd>{status?.installedVersion || version || '—'}</dd></div>
      <div><dt>Release source</dt><dd>Stable · GitHub Releases</dd></div>
      {checkedAt && <div><dt>Last check</dt><dd><time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleTimeString()}</time></dd></div>}
    </dl>
    <div role="status" aria-atomic="true">
      <p className="updates-state">{heading}</p>
      {message && <p>{message}</p>}
      {!checking && status?.state === 'error' && status.correlationId && <p>Logs reference <code>{status.correlationId}</code></p>}
    </div>
    <button disabled={checking || following || !status || status.state === 'unavailable'} onClick={() => void check()}>
      <ArrowDownToLine size={15} aria-hidden="true" /> Check for updates
    </button>
    {!checking && status?.state === 'available' && <div className="updates-notes">
      <h3>Forge {status.candidate.version}</h3>
      <p>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(status.candidate.packageBytes / 1024 / 1024)} MiB</p>
      <p className="updates-release-notes">{status.candidate.notes}</p>
      {status.candidate.canStage && job?.phase !== 'staged' && job?.phase !== 'recoveryRequired' && <button ref={installAction} disabled={following || busy} onClick={() => {
        const { version, packageSha256 } = status.candidate;
        setSelection({ version, packageSha256 });
        setProblem(undefined);
      }}>Install {status.candidate.version}</button>}
      {!status.candidate.canStage && <p>This release is unavailable for installation from Settings.</p>}
    </div>}
    {selection && <UpdateConfirmation title={`Install Forge ${selection.version}?`}
      description="Choose where to save a ZIP backup of application settings. Forge will verify the signed release and restart."
      onCancel={() => setSelection(undefined)}>
      <button className="primary" disabled={busy} onClick={() => void stage()}>Save backup and install</button>
    </UpdateConfirmation>}
    {(job || staging) && <div className="updates-notes" role="status" aria-atomic="true">
      <p className="updates-state">{job && (!staging || jobInProgress(job)) ? jobLabel[job.phase] : 'Preparing update…'}</p>
      {!staging && job?.phase === 'staged' && <p>Forge {job.targetVersion} is ready to install. Open the saved ZIP to continue.</p>}
      {!staging && job?.phase === 'healthy' && <p>Forge {job.targetVersion} passed startup checks.</p>}
      {!staging && job?.phase === 'rolledBack' && <p>Forge {job.sourceVersion} passed startup checks.</p>}
      {!staging && job?.phase === 'manualRolledBack' && <p>Forge {job.sourceVersion} is running with the settings from the original ZIP.</p>}
      {!staging && job?.message && <p>{job.message}</p>}
      {!staging && job?.phase === 'failed' && <p>Logs reference <code>{job.id}</code></p>}
      {!staging && job?.recoveryMessage && <p>{job.recoveryMessage}</p>}
    </div>}
    {!staging && job?.phase === 'staged' && <button ref={continueAction} disabled={busy} onClick={() => void restart(job, false)}>Continue installation</button>}
    {job?.canRollBack && <button ref={rollbackAction} disabled={following || busy} onClick={() => {
      setProblem(undefined);
      setRollback(job);
    }}>Roll back to {job.sourceVersion}</button>}
    {rollback && <UpdateConfirmation title={`Roll back to Forge ${rollback.sourceVersion}?`}
      description="Forge will restore the settings from the original update ZIP. This replaces changes to application settings made since the backup."
      onCancel={() => setRollback(undefined)}>
      {hasProject && <button disabled={busy} onClick={() => {
        focusAfterOperation.current = 'projectBackup';
        setRollback(undefined);
      }}>Go to project backup</button>}
      <button className="primary" disabled={busy} onClick={() => void restart(rollback, true)}>Choose original ZIP and roll back</button>
    </UpdateConfirmation>}
    {problem && <p role="alert"><span>{problem.message}</span>
      {problem.correlationId && <> Logs reference <code>{problem.correlationId}</code></>}
    </p>}
  </section>;
}

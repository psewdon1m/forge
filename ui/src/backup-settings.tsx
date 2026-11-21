import { useState } from 'react';
import { Archive, ArrowDownToLine, FolderOpen } from 'lucide-react';
import type { BackupInfo, Reply, SettingsBackupInfo, SettingsState } from './project-api';

type Selection =
  | { scope: 'project'; token: string; info: BackupInfo }
  | { scope: 'settings'; token: string; info: SettingsBackupInfo };
type Operation = 'Exporting' | 'Inspecting' | 'Restoring';

export function BackupSettings({ project, disabled, onSettingsRestored }: {
  project?: { projectId: string; baseRevision: number };
  disabled: boolean;
  onSettingsRestored: (state: SettingsState) => void;
}) {
  const api = window.forge?.project;
  const [selection, setSelection] = useState<Selection>();
  const [operation, setOperation] = useState<Operation>();
  const [notice, setNotice] = useState<{ message: string; error?: true }>();
  const locked = disabled || operation !== undefined || !api;

  async function run<T>(name: Operation, request: () => Promise<Reply<T | null>>, receive: (value: T, warning?: string) => void) {
    setOperation(name);
    setNotice(undefined);
    try {
      const reply = await request();
      if (!reply.ok) {
        setNotice({ message: reply.error.message, error: true });
        if (name === 'Restoring' && selection?.scope === 'settings') setSelection(undefined);
      } else if (reply.value !== null) {
        receive(reply.value, reply.warning);
      }
    } catch {
      setNotice({ message: 'Could not confirm the backup operation.', error: true });
    } finally {
      setOperation(undefined);
    }
  }

  const info = selection?.scope === 'project' ? selection.info : undefined;
  return <section className="panel backup-settings" aria-labelledby="backup-heading" aria-busy={operation !== undefined}>
    <h2 id="backup-heading"><Archive size={17} aria-hidden /> Backup</h2>
    <p>{project ? 'Save a copy of this project and its history.' : 'Open a project to export it. You can inspect and restore an archive here.'}</p>
    <div className="backup-actions">
      <button id="export-project-backup" disabled={locked || !project} onClick={() => {
        if (api && project) void run('Exporting', () => api.exportBackup(project), value => {
          setNotice({ message: `Exported and verified revision ${value.revision} of ${value.title}.` });
        });
      }}><ArrowDownToLine size={15} aria-hidden /> Export project</button>
      <button disabled={locked} onClick={() => {
        setSelection(undefined);
        if (api) void run('Inspecting', api.inspectBackup, value => setSelection({ scope: 'project', ...value }));
      }}><FolderOpen size={15} aria-hidden /> Inspect archive</button>
    </div>
    <div className="backup-inspection">
      <h3>Application settings</h3>
      <div className="backup-actions">
        <button disabled={locked} onClick={() => {
          if (api) void run('Exporting', api.exportSettingsBackup, value => {
            setNotice({ message: 'Settings archive saved as ' + value.name + '.' });
          });
        }}><ArrowDownToLine size={15} aria-hidden /> Export settings</button>
        <button disabled={locked} onClick={() => {
          setSelection(undefined);
          if (api) void run('Inspecting', api.inspectSettingsBackup, value => setSelection({ scope: 'settings', ...value }));
        }}><FolderOpen size={15} aria-hidden /> Inspect settings archive</button>
      </div>
    </div>
    {info && selection && <div className="backup-inspection">
      <strong>{info.title}</strong>
      <p>Revision {info.revision} · {info.files} files · {info.revisions} revisions · {info.analyses} analyses</p>
      <ArchiveDetails info={info} />
      <button disabled={locked} onClick={() => {
        if (api) void run('Restoring', () => api.restoreBackup(selection.token), (value, warning) => {
          setSelection(undefined);
          setNotice({ message: [`Created ${value.folder} in the selected folder.`, warning || 'Open the copy from Projects.'].join(' ') });
        });
      }}>Restore as copy</button>
    </div>}
    {selection?.scope === 'settings' && <div className="backup-inspection">
      <strong>{selection.info.name}</strong>
      <p>Settings schema {selection.info.schemaVersion} · Snap to grid {selection.info.snapToGrid ? 'on' : 'off'}</p>
      <ArchiveDetails info={selection.info} />
      <button disabled={locked} onClick={() => {
        if (api) void run('Restoring', () => api.restoreSettingsBackup(selection.token), value => {
          setSelection(undefined);
          onSettingsRestored(value);
          setNotice({ message: 'Application settings restored.' });
        });
      }}>Restore settings</button>
    </div>}
    {operation && <p role="status">{operation}…</p>}
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.message}</p>}
  </section>;
}

function ArchiveDetails({ info }: { info: Pick<BackupInfo, 'createdAt' | 'sourceVersion' | 'archiveBytes'> }) {
  return <p><time dateTime={info.createdAt}>{new Date(info.createdAt).toLocaleString()}</time> · Forge {info.sourceVersion} · {new Intl.NumberFormat(undefined, { notation: 'compact' }).format(info.archiveBytes)} bytes</p>;
}

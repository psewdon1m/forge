import { useEffect, useState } from 'react';
import type { ProjectRevision } from './project-api';

const reasons: Record<string, string> = {
  createProject: 'Created project',
  add: 'Added object',
  move: 'Moved object',
  moveSelection: 'Moved selection',
  renameProject: 'Renamed project',
  renameNode: 'Renamed object',
  editNote: 'Edited note',
  editChecklist: 'Edited checklist',
  editScheme: 'Edited scheme',
  editSite: 'Saved site reference',
  archiveNode: 'Archived object',
  archiveSelection: 'Archived selection',
  groupSelection: 'Grouped selection',
  ungroup: 'Ungrouped objects',
  paste: 'Pasted objects',
  importAssets: 'Imported files',
  undo: 'Undid project change',
  redo: 'Redid project change',
  restoreRevision: 'Restored revision',
};

export function ProjectHistory({ revision, busy, onRestore }: {
  revision: number;
  busy: boolean;
  onRestore: (revision: number) => void;
}) {
  const [rows, setRows] = useState<ProjectRevision[]>([]);
  const [load, setLoad] = useState<{ before?: number }>({});
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');
  const [restore, setRestore] = useState<ProjectRevision>();
  const [more, setMore] = useState(false);

  useEffect(() => {
    let valid = true;
    setLoading(true);
    setProblem('');
    const api = window.forge?.project;
    if (!api) {
      setLoading(false);
      return;
    }
    api.history(load.before).then(reply => {
      if (!valid) return;
      if (reply.ok) {
        setMore(reply.value.length === 100 && reply.value.at(-1)?.revision !== 0);
        setRows(reply.value);
      } else {
        setProblem(reply.error.message);
      }
    }).catch(() => {
      if (valid) setProblem('Could not read project history.');
    }).finally(() => {
      if (valid) setLoading(false);
    });
    return () => { valid = false; };
  }, [load, revision]);

  return <section className="panel history-panel" aria-label="Project history">
    <h2>Project history</h2>
    {loading && <p role="status">Loading revisions…</p>}
    {problem && <p role="alert">{problem} <button onClick={() => setLoad({ ...load })}>Retry</button></p>}
    {!loading && !problem && <ol className="project-list">
      {rows.map(row => <li key={row.revision}>
        <div><strong>Revision {row.revision}</strong> · {reasons[row.reason] ?? row.reason}
          <div className="history-meta"><time dateTime={row.occurredAt}>{new Date(row.occurredAt).toLocaleString()}</time> · {row.actor}</div>
        </div>
        {row.revision === revision ? <span>Current</span>
          : <button disabled={busy || restore !== undefined} onClick={() => setRestore(row)}>Restore revision {row.revision}</button>}
      </li>)}
    </ol>}
    {restore && <div className="restore-confirmation">
      <p>Restore revision {restore.revision} as a new revision? The current revision and its history will remain available.</p>
      <button className="primary" disabled={busy} autoFocus onClick={() => {
        onRestore(restore.revision);
        setRestore(undefined);
      }}>Restore as new revision</button>{' '}
      <button onClick={() => setRestore(undefined)}>Cancel</button>
    </div>}
    <div className="history-paging">
      {load.before !== undefined && <button disabled={loading || !!restore} onClick={() => setLoad({})}>Latest revisions</button>}
      {more && !problem && <button disabled={loading || !!restore} onClick={() => setLoad({ before: rows.at(-1)?.revision })}>Older revisions</button>}
    </div>
  </section>;
}

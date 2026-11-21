import React, { useEffect, useState } from 'react';
import type { GitAction, GitCard, GitPatch, GitSide, GitSnapshot, Reply } from './project-api';

type ReviewedPatch = { path: string; side: GitSide; patch: GitPatch };
type Props = GitCard & { onDirty: (dirty: boolean) => void };

export default function GitPlain({ projectId, nodeId, onDirty }: Props) {
  const api = window.forge!.project;
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>();
  const [patch, setPatch] = useState<ReviewedPatch>();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [branch, setBranch] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [message, setMessage] = useState('');
  const card = { projectId, nodeId };
  const draftCommit = !!message.trim();

  useEffect(() => { onDirty(draftCommit); }, [draftCommit, onDirty]);

  useEffect(() => {
    let active = true;
    void api.gitRead({ projectId, nodeId }).then(reply => {
      if (!active) return;
      if (reply.ok) setSnapshot(reply.value);
      else setError(reply.error.message);
    }).catch(() => {
      if (active) setError('Could not read the Git repository.');
    }).finally(() => {
      if (active) setPending(false);
    });
    return () => { active = false; };
  }, [api, projectId, nodeId]);

  async function run<T>(request: () => Promise<Reply<T>>, accept: (result: T) => void) {
    setPending(true);
    setError('');
    try {
      const reply = await request();
      if (reply.ok) accept(reply.value);
      else setError(reply.error.message);
    } catch {
      setError('Could not complete the Git operation.');
    } finally {
      setPending(false);
    }
  }

  function showState(state: GitSnapshot | null) {
    setSnapshot(state);
    setPatch(undefined);
    setBranch('');
  }

  function mutate(action: GitAction) {
    if (!snapshot) return;
    const revision = snapshot.revision;
    void run(() => api.gitMutate({ ...card, action, revision }), state => {
      showState(state);
      if (action.kind === 'commit') setMessage('');
    });
  }

  function review(path: string, side: GitSide) {
    if (!snapshot) return;
    const revision = snapshot.revision;
    void run(() => api.gitDiff({ ...card, path, side, revision }), result => setPatch({ path, side, patch: result }));
  }

  const blocked = pending || snapshot?.conflicted || snapshot?.operationInProgress;
  const staged = snapshot?.entries.some(entry => entry.staged);
  const dirty = !!snapshot?.entries.length;

  return <div className="git-plain">
    <div className="git-actions">
      <button disabled={pending || draftCommit} onClick={() => void run(() => api.gitBind(card), state => { if (state) showState(state); })}>
        {snapshot ? 'Change repository' : 'Choose repository'}
      </button>
      <button disabled={pending} onClick={() => void run(() => api.gitRead(card), showState)}>Refresh</button>
      {snapshot && <button disabled={pending || draftCommit} onClick={() => void run(() => api.gitUnbind(card), showState)}>Disconnect</button>}
    </div>
    {error && <div role="alert">{error}</div>}
    {pending && <div role="status">Reading Git state…</div>}
    {snapshot === null && <p>Choose the root of a local Git working tree. This card remembers the folder on this device.</p>}
    {snapshot && <>
      <section aria-label="Repository">
        <h3>{snapshot.repositoryName}</h3>
        <p>{snapshot.branch ?? 'Detached HEAD'}{snapshot.head ? ' · ' + snapshot.head.slice(0, 12) : ' · No commits yet'}</p>
        {snapshot.conflicted ? <p role="status">Resolve merge conflicts in your Git client before changing the repository here.</p>
          : snapshot.operationInProgress ? <p role="status">Finish the active Git operation before making changes here.</p> : null}
        {snapshot.branches.length > 0 && <div className="git-actions">
          <label>Local branches
            <select value={branch} onChange={event => setBranch(event.target.value)} disabled={pending}>
              <option value="">Choose a branch</option>
              {snapshot.branches.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
          </label>
          <button disabled={blocked || dirty || draftCommit || !branch || branch === snapshot.branch} onClick={() => mutate({ kind: 'switchBranch', branch })}>Switch branch</button>
        </div>}
        {dirty && <p>Commit or move local changes before switching branches.</p>}
        {draftCommit && <p>Commit or clear the draft message before switching branches.</p>}
      </section>
      <section aria-label="Changes">
        <h3>Changes</h3>
        {snapshot.entries.length === 0 ? <p>Working tree is clean.</p> : <ul className="git-entries">
          {snapshot.entries.map(entry => <li key={entry.path}>
            <strong>{entry.path}</strong>
            {entry.conflicted && <span>Conflicted</span>}
            {entry.staged && <div className="git-actions">
              <span>Staged · {entry.staged}</span>
              <button disabled={pending} onClick={() => review(entry.path, 'staged')}>Staged diff</button>
              <button disabled={blocked} onClick={() => mutate({ kind: 'unstage', path: entry.path })}>Unstage</button>
            </div>}
            {entry.unstaged && <div className="git-actions">
              <span>Unstaged · {entry.unstaged}</span>
              <button disabled={pending} onClick={() => review(entry.path, 'unstaged')}>Unstaged diff</button>
              <button disabled={blocked} onClick={() => mutate({ kind: 'stage', path: entry.path })}>Stage</button>
            </div>}
          </li>)}
        </ul>}
      </section>
      {patch && <section aria-label="Selected diff">
        <h3>{patch.side === 'staged' ? 'Staged' : 'Unstaged'} diff · {patch.path}</h3>
        <pre>{patch.patch.text || 'No textual changes.'}</pre>
        {patch.patch.truncated && <p>Only the beginning of this diff is shown.</p>}
      </section>}
      <section aria-label="Local commit">
        <h3>Local commit</h3>
        {!snapshot.branch && <p>Switch to a local branch to make a commit.</p>}
        <form onSubmit={event => { event.preventDefault(); mutate({ kind: 'commit', authorName, authorEmail, message }); }}>
          <label>Author name<input required disabled={pending} maxLength={120} value={authorName} onChange={event => setAuthorName(event.target.value)} /></label>
          <label>Author email<input required disabled={pending} type="email" maxLength={254} value={authorEmail} onChange={event => setAuthorEmail(event.target.value)} /></label>
          <label>Commit message<textarea required disabled={pending} maxLength={4096} rows={3} value={message} onChange={event => setMessage(event.target.value)} /></label>
          <button disabled={blocked || !staged || !snapshot.branch}>Commit staged changes</button>
        </form>
      </section>
      <section aria-label="Commit history">
        <h3>Commit history</h3>
        {snapshot.history.length ? <ol className="git-entries">
          {snapshot.history.map(commit => <li key={commit.id}>
            <strong>{commit.subject || 'Untitled commit'}</strong>
            <span>{commit.id.slice(0, 12)} · {commit.author} · {new Date(commit.timeSeconds * 1000).toLocaleDateString()}</span>
          </li>)}
        </ol> : <p>No commits on this branch.</p>}
        {snapshot.historyHasMore && <p>Showing the latest 40 commits.</p>}
      </section>
    </>}
  </div>;
}

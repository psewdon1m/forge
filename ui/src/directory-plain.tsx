import React, { useEffect, useState } from 'react';
import type { DirectoryChange, DirectoryEntry, DirectoryListing } from './project-api';

export const directoryType = 'forge.directory';

type Props = { projectId: string; nodeId: string; revision: number };
type ChosenEntry = { parent: string[]; name: string; version: string };
type NameForm = { kind: 'create' } | { kind: 'rename'; entry: ChosenEntry };

function breadcrumb(folder: string[]) {
  return ['Project root', ...folder].map((name, depth) => ({ name, path: folder.slice(0, depth) }));
}

export function DirectoryPlain({ projectId, nodeId, revision }: Props) {
  const [folder, setFolder] = useState<string[]>([]);
  const [listing, setListing] = useState<DirectoryListing>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState<NameForm>();
  const [name, setName] = useState('');
  const [moving, setMoving] = useState<ChosenEntry>();

  useEffect(() => {
    const api = window.forge?.project;
    if (!api) return;
    let current = true;
    void api.directoryList({ projectId, nodeId, folder }).then(result => {
      if (!current) return;
      if (result.ok) setListing(result.value);
      else setNotice({ text: result.error.message, error: true });
    }).catch(() => {
      if (current) setNotice({ text: 'Could not read the project folder.', error: true });
    });
    return () => { current = false; };
  }, [projectId, nodeId, folder, refresh]);

  function browse(next: string[]) {
    setListing(undefined);
    setForm(undefined);
    setNotice(undefined);
    setFolder(next);
  }

  function reload() {
    setListing(undefined);
    setRefresh(count => count + 1);
  }

  async function change(action: DirectoryChange) {
    const api = window.forge?.project;
    if (!api || pending) return;
    setPending(true);
    setNotice(undefined);
    try {
      const result = await api.changeDirectory({ projectId, nodeId, baseRevision: revision, change: action });
      if (!result.ok) {
        setNotice({ text: result.error.message, error: true });
        return;
      }
      if (!result.value) {
        setNotice({ text: 'Delete canceled' });
        return;
      }
      setForm(undefined);
      if (action.kind === 'move') {
        setMoving(undefined);
        setFolder(action.destination);
      }
      reload();
      const completed = { createFolder: 'Folder created', rename: 'Entry renamed', move: 'Entry moved', delete: 'Entry deleted' };
      setNotice({ text: completed[action.kind] });
    } catch {
      setNotice({ text: 'Could not confirm the Directory change. Refresh the folder to check.', error: true });
    } finally {
      setPending(false);
    }
  }

  function choose(entry: DirectoryEntry): ChosenEntry | undefined {
    if (!entry.version) return;
    return { parent: folder, name: entry.name, version: entry.version };
  }

  const currentPath = breadcrumb(folder);
  const sameFolder = !!moving && moving.parent.length === folder.length && moving.parent.every((name, index) => folder[index] === name);

  return <section className="directory-plain panel" aria-label="Project Directory">
    <nav className="file-actions" aria-label="Directory path">{currentPath.map((crumb, index) => (
      <button key={index} disabled={pending} aria-current={index === currentPath.length - 1 ? 'location' : undefined}
        onClick={() => browse(crumb.path)}>{crumb.name}</button>
    ))}</nav>
    <div className="file-actions">
      <button disabled={pending} onClick={() => { setNotice(undefined); reload(); }}>Refresh folder</button>
      {!moving && <button disabled={!listing || pending} onClick={() => {
        setName('');
        setForm({ kind: 'create' });
      }}>New folder</button>}
    </div>
    {moving && <section aria-label="Move destination">
      <p>Choose a destination for <strong>{moving.name}</strong>.</p>
      <div className="file-actions">
        <button disabled={!listing || pending || sameFolder} onClick={() => {
          if (listing) void change({ kind: 'move', ...moving, destination: folder, destinationVersion: listing.folderVersion });
        }}>Move here</button>
        <button disabled={pending} onClick={() => { browse(moving.parent); setMoving(undefined); }}>Cancel move</button>
      </div>
    </section>}
    {form && <form className="directory-name-form" onSubmit={event => {
      event.preventDefault();
      if (!listing || pending || !name.trim()) return;
      void change(form.kind === 'create'
        ? { kind: 'createFolder', parent: folder, folderVersion: listing.folderVersion, name }
        : { kind: 'rename', ...form.entry, newName: name });
    }}>
      <label>{form.kind === 'create' ? 'Folder name' : 'New name'}
        <input autoFocus maxLength={240} value={name} onChange={event => setName(event.currentTarget.value)} />
      </label>
      <button className="primary" disabled={!listing || pending || !name.trim() || (form.kind === 'rename' && form.entry.name === name)}>
        {form.kind === 'create' ? 'Create folder' : 'Save name'}
      </button>
      <button type="button" disabled={pending} onClick={() => setForm(undefined)}>Cancel</button>
    </form>}
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {!listing && !notice && <p role="status">Reading folder…</p>}
    {listing && listing.entries.length === 0 && <p>This folder is empty.</p>}
    {listing && listing.entries.length > 0 && <table className="directory-table">
      <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Bytes</th><th scope="col">Actions</th></tr></thead>
      <tbody>{listing.entries.map((entry, index) => {
        const selection = choose(entry);
        return <tr key={entry.name + ':' + index}>
          <td>{entry.kind === 'folder' && selection ? <button disabled={pending} onClick={() => browse([...folder, entry.name])}>{entry.name}</button> : entry.name}</td>
          <td>{entry.kind === 'folder' ? 'Folder' : entry.kind === 'file' ? 'File' : 'Unavailable'}</td>
          <td>{entry.bytes === null ? '' : new Intl.NumberFormat().format(entry.bytes)}</td>
          <td>{selection && !moving && <div className="file-actions">
            <button disabled={pending} aria-label={'Rename ' + entry.name} onClick={() => {
              setName(entry.name);
              setForm({ kind: 'rename', entry: selection });
            }}>Rename</button>
            <button disabled={pending} aria-label={'Move ' + entry.name} onClick={() => {
              setForm(undefined);
              setMoving(selection);
            }}>Move</button>
            <button disabled={pending} aria-label={'Delete ' + entry.name} onClick={() => {
              void change({ kind: 'delete', ...selection });
            }}>Delete</button>
          </div>}</td>
        </tr>;
      })}</tbody>
    </table>}
  </section>;
}

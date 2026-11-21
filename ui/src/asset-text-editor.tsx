import React, { useEffect, useState } from 'react';
import type { AssetSelection } from './project-api';

const maxTextBytes = 256 * 1024;
const bom = '\uFEFF';
const encoder = new TextEncoder();

function editorDocument(original: string) {
  const hasBom = original.startsWith(bom);
  const content = hasBom ? original.slice(1) : original;
  const endings = new Set(content.match(/\r\n|\r|\n/g));
  const lineEnding = endings.size === 1 ? [...endings][0] : '\n';
  return { initial: content.replace(/\r\n|\r/g, '\n'), hasBom, lineEnding, mixedEndings: endings.size > 1 };
}

type Props = {
  selection: AssetSelection;
  busy: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
  onSave: (text: string) => void;
};

export function AssetTextEditor({ selection, busy, onDirtyChange, onClose, onSave }: Props) {
  const [file, setFile] = useState<ReturnType<typeof editorDocument>>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const { projectId, nodeId, versionId } = selection;

  useEffect(() => {
    const api = window.forge?.project;
    if (!api) return;
    let active = true;
    void api.readAssetText({ projectId, nodeId, versionId }).then(result => {
      if (!active) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const opened = editorDocument(result.value);
      setFile(opened);
      setDraft(opened.initial);
    }).catch(() => {
      if (active) setError('The editor could not read this file');
    });
    return () => { active = false; };
  }, [projectId, nodeId, versionId]);

  if (!file) return <>
    {error ? <p role="alert">{error}</p> : <p role="status">Loading text…</p>}
    <button onClick={onClose}>Close editor</button>
  </>;

  const changed = draft !== file.initial;
  const text = (file.hasBom ? bom : '') + draft.replaceAll('\n', file.lineEnding);
  const bytes = encoder.encode(text).length;
  const invalid = bytes > maxTextBytes ? 'Text exceeds the 256 KiB editor limit'
    : draft.includes('\0') || /[\uD800-\uDFFF]/u.test(draft) ? 'Enter valid UTF-8 text without NUL characters'
    : !draft.length ? 'Enter text before saving' : '';

  return <form className="note-editor" onSubmit={event => {
    event.preventDefault();
    if (!invalid && changed && !busy) onSave(text);
  }}>
    <label>File text<textarea autoFocus value={draft} disabled={busy} onChange={event => {
      const value = event.currentTarget.value;
      setDraft(value);
      onDirtyChange(value !== file.initial);
    }} /></label>
    <span>{new Intl.NumberFormat().format(bytes)} bytes · 256 KiB limit</span>
    {file.mixedEndings && <p>Saving converts mixed line endings to LF.</p>}
    {invalid && <p role="alert">{invalid}</p>}
    <div className="file-actions">
      <button className="primary" disabled={busy || !changed || !!invalid}>Save text</button>
      <button type="button" disabled={busy} onClick={onClose}>{changed ? 'Discard changes' : 'Close editor'}</button>
    </div>
  </form>;
}

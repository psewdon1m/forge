import React, { useEffect, useState } from 'react';
import type { AssetSelection, DocumentEditState } from './project-api';

type Props = {
  selection: AssetSelection;
  busy: boolean;
  onImport: () => void;
};

export function DocumentEditActions({ selection, busy, onImport }: Props) {
  const [edit, setEdit] = useState<DocumentEditState | null>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const { projectId, nodeId, versionId } = selection;

  useEffect(() => {
    const api = window.forge?.project;
    if (!api) return;
    let active = true;
    void api.documentEditState({ projectId, nodeId, versionId }).then(reply => {
      if (!active) return;
      if (reply.ok) setEdit(reply.value);
      else setNotice({ text: reply.error.message, error: true });
    }).catch(() => {
      if (active) setNotice({ text: 'Forge could not check for an edit copy.', error: true });
    });
    return () => { active = false; };
  }, [projectId, nodeId, versionId]);

  async function act(action: 'open' | 'discard' | 'reveal') {
    const api = window.forge?.project;
    if (!api || pending || busy) return;
    setPending(true);
    setNotice(undefined);
    try {
      if (action === 'open') {
        const reply = await api.openEditCopy(selection);
        if (reply.ok && reply.value) setEdit(reply.value);
        else if (reply.ok) setNotice({ text: 'Editor selection canceled' });
        else setNotice({ text: reply.error.message, error: true });
      } else if (action === 'discard') {
        const reply = await api.discardEditCopy(selection);
        if (reply.ok && reply.value) setEdit(null);
        else if (!reply.ok) setNotice({ text: reply.error.message, error: true });
      } else {
        const reply = await api.revealEditCopy(selection);
        if (!reply.ok) setNotice({ text: reply.error.message, error: true });
      }
    } catch {
      setNotice({ text: 'The edit copy action could not be completed.', error: true });
    } finally {
      setPending(false);
    }
  }

  const disabled = busy || pending;
  return <section aria-label="Document editing">
    {edit?.stale && <p>The card has a newer version. Recover or discard this edit copy.</p>}
    {edit && !edit.stale && <p>Save and close the copy in your editor, then import the changes.</p>}
    <div className="file-actions">
      {edit === null && <button disabled={disabled} onClick={() => { void act('open'); }}>Edit copy</button>}
      {edit && !edit.stale && <>
        <button disabled={disabled} onClick={() => { void act('open'); }}>Reopen in editor</button>
        <button disabled={disabled} onClick={onImport}>Import changes</button>
      </>}
      {edit && <>
        <button disabled={disabled} onClick={() => { void act('reveal'); }}>Open copy folder</button>
        <button disabled={disabled} onClick={() => { void act('discard'); }}>Discard copy</button>
      </>}
    </div>
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>;
}

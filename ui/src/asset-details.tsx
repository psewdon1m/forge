import React, { useEffect, useRef, useState } from 'react';
import type { AssetPreview, AssetRef } from './project-api';
import { AssetTextEditor } from './asset-text-editor';
import { DocumentEditActions } from './document-edit-actions';
import { VideoPlayer, videoFormat } from './video-player';

type Props = {
  projectId: string;
  nodeId: string;
  asset: AssetRef;
  description: string;
  busy: boolean;
  visible?: boolean;
  onReplace: (nodeId: string, versionId: string) => void;
  onSaveText: (nodeId: string, versionId: string, text: string) => void;
  onImportEdit: (nodeId: string, versionId: string) => void;
  onDirtyChange: (dirty: boolean) => void;
};

export function AssetDetails({ projectId, nodeId, asset, description, busy, visible = true, onReplace, onSaveText, onImportEdit, onDirtyChange }: Props) {
  const [preview, setPreview] = useState<AssetPreview>();
  const [previewError, setPreviewError] = useState('');
  const [download, setDownload] = useState({ busy: false, message: '', error: false });
  const [opening, setOpening] = useState(false);
  const [openMessage, setOpenMessage] = useState<{ text: string; error: boolean }>();
  const [fullImage, setFullImage] = useState<string>();
  const [actualSize, setActualSize] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const activeImage = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const { versionId } = asset;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeImage.current) void window.forge?.project.releaseImage(activeImage.current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let current = true;
    const api = window.forge?.project;
    if (!api) return;
    void api.previewAsset({ projectId, nodeId, versionId }).then(result => {
      if (!current) return;
      if (result.ok) setPreview(result.value);
      else setPreviewError(result.error.message);
    }).catch(() => {
      if (current) setPreviewError('File preview is unavailable');
    });
    return () => { current = false; };
  }, [projectId, nodeId, versionId]);

  async function downloadOriginal() {
    const api = window.forge?.project;
    if (!api || download.busy) return;
    setDownload({ busy: true, error: false, message: '' });
    try {
      const result = await api.downloadAsset({ projectId, nodeId, versionId });
      if (result.ok) {
        setDownload({ busy: false, error: false, message: result.value ? 'Original downloaded' : 'Download canceled' });
      } else {
        setDownload({ busy: false, error: true, message: result.error.message });
      }
    } catch {
      setDownload({ busy: false, error: true, message: 'Download is unavailable' });
    }
  }

  async function openOriginal() {
    const api = window.forge?.project;
    if (!api || opening) return;
    setOpening(true);
    setOpenMessage(undefined);
    try {
      const reply = await api.openAsset({ projectId, nodeId, versionId });
      if (reply.ok && reply.value.kind === 'image') {
        if (!mounted.current) {
          await api.releaseImage(reply.value.src);
          return;
        }
        activeImage.current = reply.value.src;
        setActualSize(false);
        setFullImage(reply.value.src);
      } else if (mounted.current) {
        setOpenMessage(reply.ok ? { text: 'Sent to the default app', error: false } : { text: reply.error.message, error: true });
      }
    } catch {
      if (mounted.current) setOpenMessage({ text: 'The file could not be opened', error: true });
    } finally {
      if (mounted.current) setOpening(false);
    }
  }

  function closeImage() {
    const src = activeImage.current;
    activeImage.current = undefined;
    setFullImage(undefined);
    if (src) void window.forge?.project.releaseImage(src).catch(() => {});
    requestAnimationFrame(() => openButton.current?.focus());
  }

  return <section className={'panel file-details' + (fullImage ? ' full-image-panel' : '')} aria-label="File details">
    <p>{description}</p>
    <p><strong>SHA-256</strong> <code>{asset.sha256}</code></p>
    {previewError && <p role="alert">{previewError}</p>}
    {!preview && !previewError && <p role="status">Verifying file…</p>}
    {preview?.kind === 'image' && !fullImage && <img className="file-image-preview" src={preview.src} alt={asset.name} />}
    {preview?.kind === 'text' && !editing && <>
      <pre className="file-text-preview" aria-label="Text preview" tabIndex={0}>{preview.text}</pre>
      {preview.truncated && <p>Showing the first 64 KiB of text</p>}
    </>}
    {preview?.kind === 'document' && <p>File integrity verified</p>}
    {showVideo && visible && videoFormat(asset.format) && <VideoPlayer projectId={projectId} nodeId={nodeId} versionId={versionId}
      format={asset.format} name={asset.name} onClose={() => setShowVideo(false)} />}
    {fullImage && <section className="full-image" aria-label="Full-size image">
      <div className="file-actions">
        <button onClick={() => setActualSize(value => !value)}>{actualSize ? 'Fit image' : 'Actual size'}</button>
        <button autoFocus onClick={closeImage}>Close image</button>
      </div>
      <div className={'full-image-viewport' + (actualSize ? ' actual-size' : '')} tabIndex={0}>
        <img src={fullImage} alt={asset.name} onError={() => {
          closeImage();
          setOpenMessage({ text: 'The full-size image could not be displayed', error: true });
        }} />
      </div>
    </section>}
    <div className="file-actions">
      {videoFormat(asset.format) && !showVideo && <button disabled={busy || !!previewError} onClick={() => setShowVideo(true)}>Open video</button>}
      {!fullImage && <button ref={openButton} disabled={busy || opening || download.busy || editing}
        onClick={() => { void openOriginal(); }}>{opening ? 'Opening…' : 'Open file'}</button>}
      <button disabled={busy || opening || download.busy} onClick={() => { void downloadOriginal(); }}>Download original</button>
      <button disabled={busy || opening || download.busy || editing} onClick={() => onReplace(nodeId, versionId)}>Replace file</button>
      {preview?.kind === 'text' && <button ref={editButton} disabled={busy || opening || download.busy}
        aria-expanded={editing} onClick={() => setEditing(true)}>Edit text</button>}
    </div>
    {editing && <AssetTextEditor selection={{ projectId, nodeId, versionId }} busy={busy || download.busy}
      onSave={text => onSaveText(nodeId, versionId, text)} onDirtyChange={onDirtyChange}
      onClose={() => {
        setEditing(false);
        onDirtyChange(false);
        editButton.current?.focus();
      }} />}
    {(asset.format === 'pdf' || asset.format === 'docx') && <DocumentEditActions
      selection={{ projectId, nodeId, versionId }} busy={busy || opening || download.busy}
      onImport={() => onImportEdit(nodeId, versionId)} />}
    {download.message && <p role={download.error ? 'alert' : 'status'}>{download.message}</p>}
    {openMessage && <p role={openMessage.error ? 'alert' : 'status'}>{openMessage.text}</p>}
  </section>;
}

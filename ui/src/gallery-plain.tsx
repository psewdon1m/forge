import React, { useEffect, useState } from 'react';
import type { AssetPage, AssetRef, GalleryItem } from './project-api';
import { loadVideoPoster, VideoPlayer, videoFormat } from './video-player';

export const galleryType = 'forge.gallery';
const pageSize = 24;

type Props = {
  projectId: string;
  nodeId: string;
  items: GalleryItem[];
  available: AssetRef[];
  busy: boolean;
  visible: boolean;
  onImport: () => void;
  onChange: (items: GalleryItem[]) => void;
};

export function GalleryPlain({ projectId, nodeId, items, available, busy, visible, onImport, onChange }: Props) {
  const [pendingPage, setPendingPage] = useState({ offset: 0, sourceRevision: undefined as string | undefined });
  const [page, setPage] = useState<AssetPage>();
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [selected, setSelected] = useState('');
  const [openVideo, setOpenVideo] = useState('');
  const [error, setError] = useState('');
  const { offset, sourceRevision } = pendingPage;
  const members = items.map(item => item.assetId + ':' + item.versionId).join(',');

  useEffect(() => {
    if (busy || !visible) return;
    const api = window.forge?.project;
    if (!api) return;
    const controller = new AbortController();
    const { signal } = controller;
    setPage(undefined);
    setPreviews({});
    setError('');
    void (async () => {
      const reply = await api.galleryPage({ projectId, nodeId, sourceRevision, offset, limit: pageSize });
      if (signal.aborted) return;
      if (!reply.ok) {
        setError(reply.error.message);
        return;
      }
      setPage(reply.value);
      const { items, sourceRevision: pageRevision } = reply.value;
      const load = async (assets: AssetRef[]) => {
        for (const asset of assets) {
          if (signal.aborted) return;
          const input = { projectId, nodeId, sourceRevision: pageRevision, versionId: asset.versionId };
          let preview: string | null = null;
          if (videoFormat(asset.format)) preview = await loadVideoPoster({ ...input, format: asset.format }, signal);
          else {
            const result = await api.galleryPreview(input);
            if (result.ok && result.value.kind === 'image') preview = result.value.src;
          }
          if (signal.aborted) return;
          setPreviews(previous => ({ ...previous, [asset.versionId]: preview }));
        }
      };
      await Promise.all([load(items.filter(asset => !videoFormat(asset.format))),
        load(items.filter(asset => videoFormat(asset.format)))]);
    })().catch(() => {
      if (!signal.aborted) setError('The gallery could not be read.');
    });
    return () => { controller.abort(); };
  }, [projectId, nodeId, members, busy, visible, offset, sourceRevision]);

  useEffect(() => {
    setPendingPage({ offset: 0, sourceRevision: undefined });
  }, [members]);

  function move(index: number, delta: number) {
    const next = [...items];
    const target = index + delta;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  const existing = new Set(items.map(item => item.assetId));
  const candidates = [...new Map(available.filter(asset => !existing.has(asset.assetId)).map(asset => [asset.assetId, asset])).values()];
  const playing = visible && page?.items.find(item => item.versionId === openVideo);

  return <section className="gallery-plain panel" aria-label="Gallery" data-forge-file-drop={nodeId}>
    <div className="file-actions">
      <button className="primary" disabled={busy} onClick={onImport}>Import media</button>
      {candidates.length > 0 && <>
        <label>Media from Space<select value={selected} onChange={event => setSelected(event.currentTarget.value)} disabled={busy}>
          <option value="">Choose media</option>
          {candidates.map(asset => <option key={asset.assetId} value={asset.assetId}>{asset.name}</option>)}
        </select></label>
        <button disabled={busy || !candidates.some(asset => asset.assetId === selected)} onClick={() => {
          const asset = candidates.find(asset => asset.assetId === selected);
          if (!asset) return;
          onChange([...items, { assetId: asset.assetId, versionId: asset.versionId }]);
          setSelected('');
        }}>Add media</button>
      </>}
    </div>
    {error && <p role="alert">{error}</p>}
    {!page && !busy && !error && <p role="status">Reading Gallery…</p>}
    {playing && page && videoFormat(playing.format) && <VideoPlayer key={playing.versionId + ':' + page.sourceRevision}
      projectId={projectId} nodeId={nodeId} versionId={playing.versionId} sourceRevision={page.sourceRevision}
      format={playing.format} name={playing.name} poster={previews[playing.versionId]}
      onClose={() => setOpenVideo(current => current === playing.versionId ? '' : current)} />}
    {page?.total === 0 && <p>Import or drop PNG, JPEG, WebP, WebM or MP4.</p>}
    {page && page.total > 0 && <>
      <p>{offset + 1}–{offset + page.items.length} of {page.total} media items</p>
      <ul className="gallery-grid" aria-label="Gallery items">
        {page.items.map((asset, index) => {
          const preview = previews[asset.versionId];
          const position = offset + index;
          const video = videoFormat(asset.format);
          return <li key={asset.assetId}>
            <div className="gallery-thumbnail">
              {preview ? <img src={preview} alt={video ? 'Poster for ' + asset.name : asset.name} />
                : <span>{preview === null ? (video ? 'Poster unavailable' : 'Preview unavailable') : 'Loading preview…'}</span>}
            </div>
            <strong>{asset.name}</strong>
            <div className="file-actions">
              {video && <button disabled={busy} aria-label={'Open video ' + asset.name}
                onClick={() => setOpenVideo(asset.versionId)}>Open video</button>}
              <button disabled={busy || position === 0} aria-label={'Move up ' + asset.name} onClick={() => move(position, -1)}>Move up</button>
              <button disabled={busy || position === items.length - 1} aria-label={'Move down ' + asset.name} onClick={() => move(position, 1)}>Move down</button>
              <button disabled={busy} aria-label={'Remove ' + asset.name} onClick={() => onChange(items.filter(item => item.assetId !== asset.assetId))}>Remove</button>
            </div>
          </li>;
        })}
      </ul>
      <div className="file-actions">
        {offset > 0 && <button disabled={busy} onClick={() => setPendingPage({ offset: Math.max(0, offset - pageSize), sourceRevision: page.sourceRevision })}>Previous items</button>}
        {page.nextOffset !== null && <button disabled={busy} onClick={() => setPendingPage({ offset: page.nextOffset!, sourceRevision: page.sourceRevision })}>Next items</button>}
      </div>
    </>}
  </section>;
}

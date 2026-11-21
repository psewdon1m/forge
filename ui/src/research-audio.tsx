import { useEffect, useRef, useState } from 'react';
import type { AnalysisTarget, AudioMaterial, TranscriptSegment } from './project-api';

type Recording = AnalysisTarget & { sourceId: string; revision: string };
type Row = { id: string; start: string; end: string; text: string };

export function timestamp(milliseconds: number) {
  const digits = (value: number, width = 2) => String(value).padStart(width, '0');
  const seconds = Math.floor(milliseconds / 1000);
  return `${digits(Math.floor(seconds / 3600))}:${digits(Math.floor(seconds / 60) % 60)}:${digits(seconds % 60)}.${digits(milliseconds % 1000, 3)}`;
}

export function ResearchAudio({ projectId, targetId, sourceId, revision, media }: Recording & { media: AudioMaterial }) {
  const player = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [request, setRequest] = useState(0);
  useEffect(() => {
    const api = window.forge?.project;
    if (!api) return;
    let active = true;
    let url = '';
    const release = (src: string) => { void api.releaseResearchAudio(src).catch(() => {}); };
    void api.researchAudio({ projectId, targetId, sourceId, revision }).then(reply => {
      if (reply.ok) {
        if (!active) { release(reply.value.src); return; }
        url = reply.value.src;
        setSrc(url);
      } else if (active) setError(reply.error.message);
    }).catch(() => { if (active) setError('Could not load the saved recording.'); });
    return () => { active = false; if (url) release(url); };
  }, [projectId, request, revision, sourceId, targetId]);

  return <section className="research-audio" aria-label="Saved audio and transcript">
    <p>{media.asset.name} · {timestamp(media.durationMs)}</p>
    {media.transcriptOrigin && <p>Transcript by {media.transcriptOrigin.provider} · {media.transcriptOrigin.detectedLanguage} · {new Date(media.transcriptOrigin.completedAt).toISOString()}</p>}
    {src && <audio ref={player} aria-label="Saved recording" src={src} controls preload="metadata"
      onError={() => setError('Could not load the saved recording.')} />}
    {error && <><p role="alert">{error}</p><button onClick={() => { setSrc(''); setError(''); setRequest(value => value + 1); }}>Reload recording</button></>}
    {!error && !src && <p role="status">Preparing recording…</p>}
    {media.segments.length > 0 && <ol className="transcript-segments">
      {media.segments.map(segment => <li key={segment.startMs}>
        <button type="button" disabled={!src || Boolean(error)} onClick={() => { if (player.current) player.current.currentTime = segment.startMs / 1000; }}>
          {timestamp(segment.startMs)}–{timestamp(segment.endMs)}
        </button>
        <span>{segment.text}</span>
      </li>)}
    </ol>}
  </section>;
}

function newRow(start = '', end = '', text = ''): Row {
  return { id: crypto.randomUUID(), start, end, text };
}

export function TranscriptEditor({ title, media, busy, onDirty, onSave, onDiscard }: {
  title: string; media: AudioMaterial; busy: boolean; onDirty: () => void;
  onSave: (segments: TranscriptSegment[]) => void; onDiscard: () => void;
}) {
  const [rows, setRows] = useState(() => media.segments.length
    ? media.segments.map(segment => newRow(String(segment.startMs / 1000), String(segment.endMs / 1000), segment.text)) : [newRow()]);
  const [invalid, setInvalid] = useState(false);
  function update(id: string, field: 'start' | 'end' | 'text', value: string) {
    onDirty();
    setInvalid(false);
    setRows(current => current.map(row => row.id === id ? { ...row, [field]: value } : row));
  }
  function submit() {
    let previousEnd = 0;
    const segments: TranscriptSegment[] = [];
    for (const row of rows) {
      const startMs = Math.round(Number(row.start) * 1000);
      const endMs = Math.round(Number(row.end) * 1000);
      if (!row.start || !row.end || !row.text.trim() || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
        || startMs < previousEnd || startMs >= endMs || endMs > media.durationMs) {
        setInvalid(true);
        return;
      }
      segments.push({ startMs, endMs, text: row.text });
      previousEnd = endMs;
    }
    onSave(segments);
  }
  return <form className="transcript-editor" onSubmit={event => { event.preventDefault(); submit(); }}>
    <h3>Edit transcript</h3>
    <p>{title} · {timestamp(media.durationMs)}. Enter times in seconds.</p>
    {rows.map((row, index) => <fieldset key={row.id} disabled={busy}>
      <legend>Segment {index + 1}</legend>
      <label>Start (seconds)<input type="number" min="0" step="0.001" max={media.durationMs / 1000} required
        value={row.start} onChange={event => update(row.id, 'start', event.currentTarget.value)} /></label>
      <label>End (seconds)<input type="number" min="0.001" step="0.001" max={media.durationMs / 1000} required
        value={row.end} onChange={event => update(row.id, 'end', event.currentTarget.value)} /></label>
      <label>Segment text<textarea rows={2} required value={row.text} onChange={event => update(row.id, 'text', event.currentTarget.value)} /></label>
      <button type="button" onClick={() => { onDirty(); setInvalid(false); setRows(current => current.filter(item => item.id !== row.id)); }}>Remove segment</button>
    </fieldset>)}
    {invalid && <p role="alert">Use ordered, non-overlapping timestamps within the recording.</p>}
    <div className="research-actions">
      <button type="button" disabled={busy || rows.length >= 1024} onClick={() => { onDirty(); setRows(current => [...current, newRow()]); }}>Add segment</button>
      <button disabled={busy}>Save transcript</button>
      <button type="button" disabled={busy} onClick={onDiscard}>Discard transcript draft</button>
    </div>
  </form>;
}

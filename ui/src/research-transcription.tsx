import { useEffect, useRef, useState } from 'react';
import { timestamp } from './research-audio';
import type { AnalysisTarget, TranscriptionLanguage, TranscriptionResult, TranscriptionReview } from './project-api';

type Recording = { sourceId: string; revision: string; title: string };
type Props = AnalysisTarget & {
  recording: Recording;
  busy: boolean;
  onClose: () => void;
  onSave: (result: TranscriptionResult) => Promise<string | undefined>;
};

export function ResearchTranscription({ projectId, targetId, recording, busy, onClose, onSave }: Props) {
  const api = window.forge?.project;
  const [provider, setProvider] = useState('');
  const [language, setLanguage] = useState<TranscriptionLanguage>('auto');
  const [review, setReview] = useState<TranscriptionReview>();
  const [approve, setApprove] = useState(false);
  const [result, setResult] = useState<TranscriptionResult>();
  const [working, setWorking] = useState<'review' | 'send' | 'save'>();
  const [error, setError] = useState('');
  const inFlight = useRef<string | undefined>(undefined);

  useEffect(() => () => {
    if (inFlight.current) void api?.transcriptionCancel({ projectId, targetId, planId: inFlight.current }).catch(() => {});
  }, [api, projectId, targetId]);

  function invalidate() { setReview(undefined); setApprove(false); setError(''); }
  async function prepare() {
    if (!api || provider !== 'whisper.cpp') return;
    invalidate();
    setWorking('review');
    try {
      const reply = await api.transcriptionReview({ projectId, targetId, sourceId: recording.sourceId,
        revision: recording.revision, provider, language });
      if (reply.ok) setReview(reply.value);
      else setError(reply.error.message);
    } catch { setError('Could not review this recording.'); }
    finally { setWorking(undefined); }
  }

  async function send() {
    if (!api || !review || !approve) return;
    inFlight.current = review.id;
    setWorking('send');
    setError('');
    setReview(undefined);
    setApprove(false);
    try {
      const reply = await api.transcriptionStart({ projectId, targetId, planId: review.id, approve });
      if (reply.ok) setResult(reply.value);
      else setError(reply.error.message);
    } catch { setError('Could not finish the transcription.'); }
    finally { inFlight.current = undefined; setWorking(undefined); }
  }

  async function save() {
    if (!result) return;
    setWorking('save');
    setError('');
    try {
      const failure = await onSave(result);
      if (failure) setError(failure);
    } catch { setError('Could not confirm the saved transcript.'); }
    finally { setWorking(undefined); }
  }

  return <section className="transcription-panel" aria-label="Automatic transcription">
    <h3>Automatic transcription</h3>
    <p>{recording.title}</p>
    {!result && <fieldset disabled={busy || Boolean(working)}>
      <legend>Provider and language</legend>
      <label>Transcription provider<select value={provider} onChange={event => { invalidate(); setProvider(event.currentTarget.value); }}>
        <option value="">Choose provider</option><option value="whisper.cpp">whisper.cpp on this computer</option>
      </select></label>
      <label>Transcription language<select value={language} onChange={event => { invalidate(); setLanguage(event.currentTarget.value as TranscriptionLanguage); }}>
        <option value="auto">Detect automatically</option><option value="en">English</option><option value="ru">Russian</option>
      </select></label>
      <button type="button" disabled={!provider} onClick={() => { void prepare(); }}>Review recording</button>
    </fieldset>}
    {review && <section aria-label="Recording transfer review">
      <h4>{review.asset.name} · {new Intl.NumberFormat().format(review.asset.bytes)} bytes</h4>
      <p>{review.provider} · {review.endpoint} · {timestamp(review.durationMs)}</p>
      <p>Recording version <code>{review.asset.versionId}</code></p>
      <p>Research revision <code>{review.revision}</code></p>
      <p>SHA-256 <code>{review.asset.sha256}</code></p>
      <label className="research-checkbox"><input type="checkbox" checked={approve} disabled={busy}
        onChange={event => setApprove(event.currentTarget.checked)} /> Allow sending this WAV</label>
      <button type="button" className="primary" disabled={!approve || busy} onClick={() => { void send(); }}>Send recording</button>
    </section>}
    {working === 'review' && <p role="status">Preparing recording review…</p>}
    {working === 'send' && <div><p role="status">Waiting for transcription…</p>
      <button type="button" onClick={() => {
        if (inFlight.current) void api?.transcriptionCancel({ projectId, targetId, planId: inFlight.current });
      }}>Cancel transcription</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {result && <section aria-label="Transcript preview">
      <h4>Transcript preview</h4><p>{result.origin.provider} · {result.origin.detectedLanguage}</p>
      <ol className="transcript-segments">{result.segments.map(segment => <li key={segment.startMs}>
        <code>{timestamp(segment.startMs)}–{timestamp(segment.endMs)}</code> {segment.text}
      </li>)}</ol>
      <button type="button" className="primary" disabled={busy || Boolean(working)} onClick={() => { void save(); }}>Save automatic transcript</button>
    </section>}
    <button type="button" disabled={Boolean(working)} onClick={onClose}>Close transcription</button>
  </section>;
}

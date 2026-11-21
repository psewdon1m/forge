import { useEffect, useMemo, useRef, useState } from 'react';
import { imageFormat, type LinkNode } from './data-links';
import { ResearchAudio, TranscriptEditor, timestamp } from './research-audio';
import { ResearchTranscription } from './research-transcription';
import type { AnalysisTarget, AudioMaterial, DataLink, LinkedFilePage, ResearchAction, ResearchCitation, ResearchDocument, ResearchStatus, ResearchVersion } from './project-api';

type Props = AnalysisTarget & {
  document: ResearchDocument; revision: number; busy: boolean; links: DataLink[]; nodes: LinkNode[];
  onSave: (action: ResearchAction, done?: () => void) => void;
  onSaveTranscription: (id: string) => Promise<string | undefined>;
  onDirty: (dirty: boolean) => void;
};
type PdfAction = Extract<ResearchAction, { kind: 'capture' | 'refresh' }>;
type SourceDraft = { kind: 'manual'; id: string | null; title: string; text: string } |
  { kind: 'pdf'; action: PdfAction; versionId: string; title: string; text: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function textOf(version?: ResearchVersion) {
  const material = version?.material;
  if (material?.kind === 'audio') return material.segments.map(segment => segment.text).join('\n');
  return material?.kind === 'site' ? material.reference.quote : material?.text ?? '';
}

function sourceByteOffset(text: string, position: number) {
  let offset = 0;
  for (let visible = 0; visible < position && offset < text.length; visible++) {
    offset += text[offset] === '\r' && text[offset + 1] === '\n' ? 2 : 1;
  }
  const next = text.charCodeAt(offset);
  if (next >= 0xdc00 && next <= 0xdfff) return null;
  return encoder.encode(text.slice(0, offset)).length;
}

function citationText(document: ResearchDocument, citation: ResearchCitation) {
  const source = document.sources.find(item => item.id === citation.sourceId);
  const version = source?.versions.find(item => item.revision === citation.revision);
  let time: string | undefined;
  if (version?.material.kind === 'audio') {
    let offset = 0;
    let start: number | undefined;
    let end: number | undefined;
    for (const segment of version.material.segments) {
      const next = offset + encoder.encode(segment.text).length;
      if (citation.start < next && citation.end > offset) {
        start ??= segment.startMs;
        end = segment.endMs;
      }
      offset = next + 1;
    }
    if (start !== undefined && end !== undefined) time = `${timestamp(start)}–${timestamp(end)}`;
  }
  return { title: version?.title ?? 'Saved source', quote: decoder.decode(encoder.encode(textOf(version)).slice(citation.start, citation.end)), time };
}

export default function ResearchPlain({ projectId, targetId, document, revision, busy, links, nodes, onSave, onSaveTranscription, onDirty }: Props) {
  const api = window.forge?.project;
  const [status, setStatus] = useState<{ value: ResearchStatus; projectRevision: number }>();
  const [statusError, setStatusError] = useState('');
  const [linkId, setLinkId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [page, setPage] = useState<LinkedFilePage>();
  const [offset, setOffset] = useState(0);
  const [linkError, setLinkError] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [savedVersion, setSavedVersion] = useState('');
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState<SourceDraft>();
  const [transcript, setTranscript] = useState<{ sourceId: string; revision: string; title: string; media: AudioMaterial }>();
  const [transcriptDirty, setTranscriptDirty] = useState(false);
  const [automatic, setAutomatic] = useState<{ sourceId: string; revision: string; title: string }>();
  const [draft, setDraft] = useState('');
  const [citationIds, setCitationIds] = useState<string[]>([]);
  const [selection, setSelection] = useState(false);
  const [preview, setPreview] = useState<{ revision: string; src?: string; error?: string }>();
  const textField = useRef<HTMLTextAreaElement>(null);

  const choices = links.flatMap(link => {
    const node = nodes.find(node => node.id === link.source.nodeId);
    if (!node || link.target.nodeId !== targetId || link.target.portId !== 'sources' || node.kind === 'directory') return [];
    if (node.kind === 'asset' && node.format && !imageFormat(node.format) && !['txt', 'md', 'pdf', 'wav'].includes(node.format)) return [];
    return [{ id: link.id, label: `${node.title} · ${link.source.portId}`, title: node.title,
      gallery: node.kind === 'gallery', pdfVersion: node.format === 'pdf' ? node.assetVersionId : undefined }];
  });
  const link = choices.find(choice => choice.id === linkId);
  const source = document.sources.find(item => item.id === sourceId) ?? document.sources[0];
  const origin = source?.origin;
  const sourceLink = origin?.kind === 'linked' ? choices.find(choice => choice.id === origin.linkId) : undefined;
  const version = source?.versions.find(item => item.revision === savedVersion)
    ?? source?.versions.find(item => item.revision === source.activeRevision);
  const current = status?.projectRevision === revision ? status.value : undefined;
  const sourceState = current?.sources.find(item => item.id === source?.id)?.state;
  const text = textOf(version);
  const image = version?.material.kind === 'file' && imageFormat(version.material.asset.format);
  const imageRevision = image ? version?.revision : undefined;
  const selectedId = source?.id;

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    setStatusError('');
    void api.researchStatus({ projectId, targetId }).then(reply => {
      if (!mounted) return;
      if (reply.ok) setStatus({ value: reply.value, projectRevision: revision });
      else setStatusError(reply.error.message);
    }).catch(() => { if (mounted) setStatusError('Could not check source versions.'); });
    return () => { mounted = false; };
  }, [api, projectId, targetId, revision]);

  const galleryId = link?.gallery ? link.id : undefined;
  useEffect(() => {
    setPage(undefined);
    setAssetId('');
    setLinkError('');
    if (!api || !galleryId) return;
    let mounted = true;
    void api.linkedAssets({ projectId, targetId, linkId: galleryId, offset, limit: 24 }).then(reply => {
      if (!mounted) return;
      if (reply.ok) setPage(reply.value);
      else setLinkError(reply.error.message);
    }).catch(() => { if (mounted) setLinkError('Could not read linked images.'); });
    return () => { mounted = false; };
  }, [api, projectId, targetId, galleryId, offset, revision]);

  useEffect(() => {
    setSelection(false);
    if (!api || !selectedId || !imageRevision) return;
    let mounted = true;
    void api.researchPreview({ projectId, targetId, sourceId: selectedId, revision: imageRevision }).then(reply => {
      if (!mounted) return;
      if (reply.ok && reply.value.kind === 'image') setPreview({ revision: imageRevision, src: reply.value.src });
      else setPreview({ revision: imageRevision, error: reply.ok ? 'Image preview unavailable.' : reply.error.message });
    }).catch(() => { if (mounted) setPreview({ revision: imageRevision, error: 'Could not load the image.' }); });
    return () => { mounted = false; };
  }, [api, projectId, targetId, selectedId, imageRevision, version?.revision]);

  useEffect(() => { onDirty(Boolean(manual?.title || manual?.text || draft || transcriptDirty || automatic)); }, [manual, draft, transcriptDirty, automatic, onDirty]);

  function cite() {
    const field = textField.current;
    if (!field || !source || !version || field.selectionStart >= field.selectionEnd) return;
    const start = sourceByteOffset(text, field.selectionStart);
    const end = sourceByteOffset(text, field.selectionEnd);
    if (start === null || end === null) return;
    onSave({ kind: 'cite', sourceId: source.id, revision: version.revision, start, end });
  }

  function enterPdfText(title: string, versionId: string, action: PdfAction) {
    setManual({ kind: 'pdf', title, versionId, text: '', action });
  }

  const searchIndex = useMemo(() => document.sources.map(item => ({
    item,
    versions: item.versions.slice().reverse().map(version => ({
      version,
      text: (version.title + '\n' + textOf(version)).toLowerCase(),
    })),
  })), [document.sources]);
  const indexedVersions = searchIndex.reduce((count, source) => count + source.versions.length, 0);
  const term = query.trim().toLowerCase();
  const searched = searchIndex.flatMap(({ item, versions }) => {
    const matches = ({ text }: { text: string }) => text.includes(term);
    const active = versions.find(({ version }) => version.revision === item.activeRevision);
    const result = active && matches(active) ? active : versions.find(matches);
    return result ? [{ item, result: result.version }] : [];
  });
  return <section className="research-panel" aria-label="Research sources">
    <div className="research-grid">
      <section>
        <h3>Sources</h3>
        <label>Search saved sources<input value={query} onChange={event => setQuery(event.currentTarget.value)} /></label>
        {indexedVersions > 0 && <p role="status" aria-label="Research search index">
          {indexedVersions} saved {indexedVersions === 1 ? 'version' : 'versions'} indexed
        </p>}
        <ul className="research-sources">{searched.map(({ item, result }) => {
          const state = current?.sources.find(value => value.id === item.id)?.state;
          return <li key={item.id}><button aria-pressed={item.id === source?.id && result.revision === version?.revision} onClick={() => { setSourceId(item.id); setSavedVersion(term ? result.revision : ''); }}>
            {result.title}{state && state !== 'current' && <small>{state === 'changed' ? 'Source changed' : 'Link unavailable'}</small>}
          </button></li>;
        })}</ul>
        {!searched.length && <p>{term ? 'No saved sources match.' : 'Add a manual source or capture a saved Data Link.'}</p>}
        <label>Linked source<select value={link?.id ?? ''} onChange={event => { setLinkId(event.currentTarget.value); setOffset(0); setAssetId(''); }}>
          <option value="">Choose a link</option>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select></label>
        {linkError && <p role="alert">{linkError}</p>}
        {link?.gallery && page && <>
          <label>Linked image<select value={assetId} onChange={event => setAssetId(event.currentTarget.value)}>
            <option value="">Choose an image</option>{page.items.filter(item => item.format && imageFormat(item.format))
              .map(item => <option key={item.assetId} value={item.assetId}>{item.name}</option>)}
          </select></label>
          {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - 24))}>Previous images</button>}{' '}
          {page.nextOffset !== null && <button onClick={() => setOffset(page.nextOffset!)}>Next images</button>}
        </>}
        <div className="research-actions"><button disabled={busy || !link || Boolean(link.gallery && !assetId)} onClick={() => {
          if (link) onSave({ kind: 'capture', linkId: link.id, assetId: link.gallery ? assetId : null });
        }}>Capture source</button>
        {link?.pdfVersion && <button disabled={busy || Boolean(manual)} onClick={() => {
          if (link.pdfVersion) enterPdfText(link.title, link.pdfVersion, { kind: 'capture', linkId: link.id, assetId: null });
        }}>Enter PDF text</button>}
        <button disabled={busy || Boolean(manual)} onClick={() => setManual({ kind: 'manual', id: null, title: '', text: '' })}>Add manual source</button></div>
      </section>
      <section>
        {statusError && <p role="alert">{statusError}</p>}
        {automatic && <ResearchTranscription projectId={projectId} targetId={targetId} recording={automatic}
          busy={busy} onClose={() => setAutomatic(undefined)} onSave={async result => {
            const failure = await onSaveTranscription(result.id);
            if (!failure) { setSourceId(result.sourceId); setSavedVersion(''); setAutomatic(undefined); }
            return failure;
          }} />}
        {transcript && <TranscriptEditor title={transcript.title} media={transcript.media} busy={busy}
          onDirty={() => setTranscriptDirty(true)} onDiscard={() => { setTranscript(undefined); setTranscriptDirty(false); }}
          onSave={segments => onSave({ kind: 'setTranscript', sourceId: transcript.sourceId, revision: transcript.revision, segments }, () => {
            setSourceId(transcript.sourceId);
            setSavedVersion('');
            setTranscript(undefined);
            setTranscriptDirty(false);
          })} />}
        {manual && <form className="research-actions-column" onSubmit={event => {
          event.preventDefault();
          const action: ResearchAction = manual.kind === 'pdf'
            ? { ...manual.action, pdfText: { versionId: manual.versionId, text: manual.text } }
            : { kind: 'manual', sourceId: manual.id, title: manual.title, text: manual.text };
          onSave(action, () => { setManual(undefined); if (action.kind === 'refresh') setSavedVersion(''); });
        }}>
          <h3>{manual.kind === 'pdf' ? 'Manual PDF text' : manual.id ? 'Edit manual source' : 'New manual source'}</h3>
          {manual.kind === 'pdf' ? <p>{manual.title}</p> : <label>Source title<input value={manual.title} onChange={event => setManual({ ...manual, title: event.currentTarget.value })} maxLength={240} required /></label>}
          <label>{manual.kind === 'pdf' ? 'PDF text' : 'Source text'}<textarea value={manual.text} onChange={event => setManual({ ...manual, text: event.currentTarget.value })} required rows={5} /></label>
          <div className="research-actions"><button disabled={busy || !manual.title.trim() || !manual.text.trim()}>Save source version</button>
          <button type="button" disabled={busy} onClick={() => setManual(undefined)}>Discard source draft</button></div>
        </form>}
        {source && version && <>
          <h3>{version.title}</h3>
          <label className="research-checkbox"><input type="checkbox" checked={source.projectOnly ?? false} disabled={busy}
            onChange={event => onSave({ kind: 'setProjectOnly', sourceId: source.id, projectOnly: event.currentTarget.checked })} /> Keep in this project</label>
          <label>Saved source version<select value={version.revision} onChange={event => setSavedVersion(event.currentTarget.value)}>
            {source.versions.map((item, index) => <option key={item.revision} value={item.revision}>Version {index + 1}{item.revision === source.activeRevision ? ' · current' : ''}</option>)}
          </select></label>
          {version.material.kind === 'site' && <p className="research-url">{version.material.reference.url}</p>}
          {version.material.kind === 'pdf' && <p>{version.material.extraction === 'manual' ? 'Manually entered PDF text' : 'Extracted from the PDF text layer'}</p>}
          {version.material.kind === 'audio' && <ResearchAudio key={version.revision} projectId={projectId} targetId={targetId}
            sourceId={source.id} revision={version.revision} media={version.material} />}
          {text && <label>Saved source text<textarea key={version.revision} ref={textField} rows={7} value={text} readOnly
            onSelect={event => setSelection(event.currentTarget.selectionStart < event.currentTarget.selectionEnd)} /></label>}
          {image && preview?.revision === imageRevision && preview?.src && <img className="research-image" src={preview.src} alt={version.title} />}
          {image && preview?.revision === imageRevision && preview?.error && <p role="alert">{preview.error}</p>}
          <div className="research-actions">
            {text && <button disabled={busy || !selection} onClick={cite}>Save selected text as citation</button>}
            {sourceState === 'changed' && <button disabled={busy} onClick={() => onSave({ kind: 'refresh', sourceId: source.id }, () => setSavedVersion(''))}>Capture latest version</button>}
            {sourceState === 'changed' && sourceLink?.pdfVersion && <button disabled={busy || Boolean(manual)} onClick={() => {
              if (sourceLink.pdfVersion) enterPdfText(sourceLink.title, sourceLink.pdfVersion, { kind: 'refresh', sourceId: source.id });
            }}>Enter updated PDF text</button>}
            {source.origin.kind === 'manual' && <button disabled={busy || Boolean(manual)} onClick={() => setManual({ kind: 'manual', id: source.id, title: version.title, text })}>Edit manual source</button>}
            {version.material.kind === 'audio' && version.revision === source.activeRevision && <button type="button" disabled={busy || Boolean(transcript || automatic)} onClick={() => {
              if (version.material.kind === 'audio') setTranscript({ sourceId: source.id, revision: version.revision, title: version.title, media: version.material });
            }}>{version.material.segments.length ? 'Edit transcript' : 'Add transcript'}</button>}
            {version.material.kind === 'audio' && version.revision === source.activeRevision && sourceState === 'current' && !source.projectOnly &&
              <button type="button" disabled={busy || Boolean(transcript || automatic)} onClick={() =>
                setAutomatic({ sourceId: source.id, revision: version.revision, title: version.title })}>Transcribe automatically</button>}
          </div>
        </>}
      </section>
    </div>
    <section className="research-records">
      <h3>Citations</h3>
      {document.citations.map(citation => {
        const { title, quote, time } = citationText(document, citation);
        return <figure key={citation.id}><blockquote>{quote}</blockquote><figcaption>{title} · <code title={citation.revision}>{citation.revision.slice(0, 12)}</code>
          {time && <> · {time}</>} · bytes {citation.start}–{citation.end}</figcaption></figure>;
      })}
      <h3>Conclusions</h3>
      {document.conclusions.map(conclusion => {
        const stale = current && (conclusion.contextRevision !== current.contextRevision || current.sources.some(item => item.state !== 'current'));
        return <article key={conclusion.id}><p>{conclusion.text}</p><p role="status">{!current ? 'Checking source versions…' : stale ? 'Based on an earlier source context' : 'Current source context'}</p>
          {conclusion.citationIds.map(id => { const citation = document.citations.find(item => item.id === id); return citation && <blockquote key={id}>{citationText(document, citation).quote}</blockquote>; })}
        </article>;
      })}
      <form onSubmit={event => { event.preventDefault(); onSave({ kind: 'conclude', text: draft, citationIds }, () => { setDraft(''); setCitationIds([]); }); }}>
        <label>New conclusion<textarea rows={4} value={draft} onChange={event => setDraft(event.currentTarget.value)} required /></label>
        {document.citations.map(citation => <label key={citation.id} className="research-checkbox"><input type="checkbox" checked={citationIds.includes(citation.id)} onChange={event => {
          const checked = event.currentTarget.checked;
          setCitationIds(ids => checked ? [...ids, citation.id] : ids.filter(id => id !== citation.id));
        }} /> {citationText(document, citation).quote.slice(0, 120)}</label>)}
        <button disabled={busy || !draft.trim()}>Save conclusion</button>{' '}
        {draft && <button type="button" disabled={busy} onClick={() => { setDraft(''); setCitationIds([]); }}>Discard conclusion draft</button>}
      </form>
    </section>
  </section>;
}

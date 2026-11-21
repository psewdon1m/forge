import { useEffect, useState } from 'react';
import type { LinkNode } from './data-links';
import type { AnalysisTarget, DataLink, ModelManifestItem, ModelPick, ModelProvider, ModelResult, ModelReview, ModelSelection } from './project-api';

type Choice = { link: DataLink; node: LinkNode; pick: ModelPick };
type Props = AnalysisTarget & {
  revision: number; links: DataLink[]; nodes: LinkNode[]; saved: ModelResult[];
  onDirty: (dirty: boolean) => void; onSave: (resultId: string) => Promise<string | undefined>;
};

function defaultPick(link: DataLink): ModelPick {
  switch (link.dataType) {
    case 'ColorPalette': return { kind: 'palette' };
    case 'ResearchSources': return { kind: 'research', sourceIds: [] };
    case 'TabularData': return { kind: 'dataset', offset: 0, limit: 10 };
    default: return { kind: link.source.portId === 'quote' ? 'site' : 'text' };
  }
}

const providerName = (provider: ModelProvider) => provider === 'ollama' ? 'Ollama' : 'Local deterministic test';

function Provenance({ item }: { item: ModelManifestItem }) {
  return <><p>{item.kind} · {item.bytes} bytes · {item.extraction}</p>
    <p>Revision <code>{item.revision}</code></p>
    <p>Content SHA-256 <code>{item.contentSha256}</code></p>
    {item.citations.length > 0 && <ul>{item.citations.map(citation => <li key={citation.id}>Citation {citation.id} · bytes {citation.start}–{citation.end}</li>)}</ul>}</>;
}

function SentSources({ materials, links }: { materials: ModelManifestItem[]; links: DataLink[] }) {
  return <>{materials.map((source, index) => <div key={index}><h4>@{source.title}</h4>
    {!links.some(link => link.id === source.linkId) && <p>Source link unavailable. Showing the saved provenance.</p>}
    <Provenance item={source} /></div>)}</>;
}

export default function IntelligentPlain({ projectId, targetId, revision, links, nodes, saved, onDirty, onSave }: Props) {
  const api = window.forge?.project;
  const [provider, setProvider] = useState<ModelProvider>('forge-test');
  const [model, setModel] = useState('');
  const [outputTokens, setOutputTokens] = useState(512);
  const [prompt, setPrompt] = useState('');
  const [choices, setChoices] = useState<Record<string, ModelPick>>({});
  const [review, setReview] = useState<ModelReview>();
  const [approveSite, setApproveSite] = useState(false);
  const [working, setWorking] = useState<'review' | 'send' | 'save'>();
  const [error, setError] = useState('');
  const [result, setResult] = useState<ModelResult>();
  const available: Choice[] = links.flatMap(link => {
    const node = nodes.find(item => item.id === link.source.nodeId);
    return link.target.nodeId === targetId && node ? [{ link, node, pick: defaultPick(link) }] : [];
  });
  const selections: ModelSelection[] = available.flatMap(({ link, node }) => choices[link.id]
    ? [{ linkId: link.id, nodeId: node.id, pick: choices[link.id] }] : []);
  const isSaved = Boolean(result && saved.some(item => item.id === result.id));

  function invalidate() { setReview(undefined); setApproveSite(false); setError(''); }
  function setPick(id: string, pick?: ModelPick) {
    invalidate();
    setChoices(current => {
      const next = { ...current };
      if (pick) next[id] = pick;
      else delete next[id];
      return next;
    });
  }
  useEffect(() => { setReview(undefined); setApproveSite(false); }, [revision]);
  useEffect(() => { onDirty(Boolean(prompt.trim() || (result && !isSaved))); }, [prompt, result, isSaved, onDirty]);
  useEffect(() => () => { void api?.modelCancel({ projectId, targetId }).catch(() => {}); }, [api, projectId, targetId]);

  async function prepare() {
    if (!api) return;
    invalidate(); setWorking('review');
    try {
      const reply = await api.modelReview({ projectId, targetId, prompt, provider, model, outputTokens, selections });
      if (reply.ok) setReview(reply.value);
      else setError(reply.error.message);
    } catch { setError('Could not prepare the model review.'); }
    finally { setWorking(undefined); }
  }
  async function send() {
    if (!review || !api) return;
    setReview(undefined); setWorking('send'); setError('');
    try {
      const reply = await api.modelSend({ projectId, targetId, planId: review.id, approveSite });
      if (reply.ok) setResult(reply.value);
      else setError(reply.error.message);
    } catch { setError('Could not finish the model request.'); }
    finally { setWorking(undefined); }
  }
  async function save() {
    if (!result) return;
    setWorking('save'); setError('');
    try {
      const failure = await onSave(result.id);
      if (failure) setError(failure);
      else setPrompt('');
    } catch { setError('Could not confirm the saved result.'); }
    finally { setWorking(undefined); }
  }

  return <section className="intelligent-panel" aria-label="Intelligent context">
    <fieldset disabled={Boolean(working)}>
      <legend>Request</legend>
      <label>Provider<select value={provider} onChange={event => { invalidate(); setProvider(event.currentTarget.value as ModelProvider); }}>
        <option value="forge-test">Local deterministic test</option><option value="ollama">Ollama on this computer</option>
      </select></label>
      {provider === 'ollama' && <>
        <label>Installed model<input value={model} onChange={event => { invalidate(); setModel(event.currentTarget.value); }} maxLength={120} /></label>
        <label>Output tokens<select value={outputTokens} onChange={event => { invalidate(); setOutputTokens(Number(event.currentTarget.value)); }}>
          {[256, 512, 1024, 2048].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </>}
      <label>Model request<textarea rows={4} value={prompt} onChange={event => { invalidate(); setPrompt(event.currentTarget.value); }} /></label>
    </fieldset>
    <fieldset disabled={Boolean(working)}>
      <legend>Linked sources</legend>
      {!available.length && <p>Use Links in Space to connect Palette, Research, Dataset, Site or text.</p>}
      {available.map(({ link, node, pick }) => {
        const selected = choices[link.id];
        return <fieldset key={link.id}>
          <legend>@{node.title} · {node.id.slice(0, 8)}</legend>
          <label className="model-check"><input type="checkbox" checked={Boolean(selected)} onChange={event => setPick(link.id, event.currentTarget.checked ? pick : undefined)} /> Include @{node.title} · {node.id.slice(0, 8)}</label>
          {selected?.kind === 'research' && node.research?.sources.map(source => {
            const version = source.versions.find(item => item.revision === source.activeRevision);
            return <label className="model-check" key={source.id}><input type="checkbox" disabled={source.projectOnly}
              checked={selected.sourceIds.includes(source.id)} onChange={event => {
                setPick(link.id, { kind: 'research', sourceIds: event.currentTarget.checked ? [...selected.sourceIds, source.id] : selected.sourceIds.filter(id => id !== source.id) });
              }} /> {version?.title} · {source.id.slice(0, 8)}{source.projectOnly ? ' · Project only' : ''}</label>;
          })}
          {selected?.kind === 'dataset' && <>
            <label>First row<input type="number" min={1} value={selected.offset + 1} onChange={event => setPick(link.id, { ...selected, offset: Number(event.currentTarget.value) - 1 })}/></label>
            <label>Row count<input type="number" min={1} max={100} value={selected.limit} onChange={event => setPick(link.id, { ...selected, limit: Number(event.currentTarget.value) })}/></label>
          </>}
        </fieldset>;
      })}
      <button disabled={!prompt.trim() || !selections.length || (provider === 'ollama' && !model.trim())} onClick={() => { void prepare(); }}>Review context</button>
      {prompt && <button onClick={() => { setPrompt(''); invalidate(); }}>Clear request</button>}
    </fieldset>
    {working === 'review' && <p role="status">Preparing context…</p>}
    {review && <section aria-label="Exact model context">
      <h3>Review before sending</h3><p>{providerName(review.provider)} · {review.model} · {review.bytes} of {review.limit} bytes</p>
      {review.endpoint && <p>{review.endpoint}</p>}
      {review.materials.map(({ manifest, text }, index) => <details key={index}><summary>{index + 1}. @{manifest.title} · {manifest.kind} · {manifest.bytes} bytes</summary>
        <Provenance item={manifest} /><pre>{text}</pre></details>)}
      {review.requiresSiteApproval && <label className="model-check"><input type="checkbox" checked={approveSite} onChange={event => setApproveSite(event.currentTarget.checked)} /> Allow the Site quotes in this review</label>}
      <button className="primary" disabled={review.requiresSiteApproval && !approveSite} onClick={() => { void send(); }}>Send</button>
    </section>}
    {working === 'send' && <div><p role="status">Waiting for the model…</p><button onClick={() => { void api?.modelCancel({ projectId, targetId }); }}>Cancel request</button></div>}
    {error && <p role="alert">{error}</p>}
    {result && <section aria-label="Latest model result"><h3>Latest result</h3><pre>{result.text}</pre>
      <p>{providerName(result.provider)} · {result.model} · {new Date(result.occurredAt).toISOString()}</p>
      <p>Request digest <code>{result.digest}</code></p>
      <details><summary>Sent source versions</summary><SentSources materials={result.materials} links={links} /></details>
      {isSaved ? <p role="status">Saved to project</p> : <button disabled={Boolean(working)} onClick={() => { void save(); }}>Save result to project</button>}
    </section>}
    {saved.length > 0 && <section aria-label="Saved model results"><h3>Saved results</h3>
      {saved.slice().reverse().map(item => <details key={item.id}>
        <summary>{providerName(item.provider)} · {item.model} · {new Date(item.occurredAt).toISOString()}</summary>
        <pre>{item.text}</pre><p>Request digest <code>{item.digest}</code></p>
        <SentSources materials={item.materials} links={links} />
      </details>)}
    </section>}
  </section>;
}

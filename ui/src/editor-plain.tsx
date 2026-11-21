import { useEffect, useRef, useState } from 'react';
import type { LinkNode } from './data-links';
import type {
  AnalysisTarget, AssetRef, DataLink, EditorDocument, EditorExportInput, EditorFormat, EditorGraph,
  EditorOperation, EditorPreview, EditorSelection, EditorStep, ImportResult, LinkedFilePage, Reply,
} from './project-api';

type Choice = { selection: EditorSelection; asset: AssetRef };
type Props = AnalysisTarget & {
  document: EditorDocument;
  revision: number;
  links: DataLink[];
  nodes: LinkNode[];
  busy: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (graph: EditorGraph, selection: EditorSelection | undefined, done: () => void) => void;
  onExport: (request: EditorExportInput) => Promise<Reply<ImportResult | null>>;
};
const labels = { crop: 'Crop', resize: 'Resize', exposure: 'Exposure', color: 'Color adjustment' } as const;
const pageSize = 24;

function ordered(graph?: EditorGraph) {
  if (!graph) return [];
  const steps: EditorStep[] = [];
  for (let id = graph.output; id && steps.length < graph.nodes.length;) {
    const node = graph.nodes.find(node => node.id === id);
    if (!node) break;
    steps.unshift(node);
    id = node.input;
  }
  return steps;
}

function graphOf(steps: EditorStep[]): EditorGraph {
  return {
    nodes: steps.map((step, index) => ({ ...step, input: steps[index - 1]?.id ?? null })),
    output: steps.at(-1)?.id ?? null,
  };
}

function SourceChooser({ projectId, targetId, link, title, revision, selected, onPick }:
  AnalysisTarget & { link: DataLink; title: string; revision: number; selected?: Choice; onPick: (value: Choice) => void }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LinkedFilePage>();
  const [error, setError] = useState('');
  const pageRevision = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError('');
    void window.forge?.project.linkedAssets({ projectId, targetId, linkId: link.id,
      offset, limit: pageSize, sourceRevision: offset ? pageRevision.current : undefined }).then(reply => {
      if (!active) return;
      if (reply.ok) {
        pageRevision.current = reply.value.sourceRevision;
        setPage(reply.value);
      } else if (offset && reply.error.code === 'SOURCE_CHANGED') {
        setOffset(0);
      } else setError(reply.error.message);
    }).catch(() => { if (active) setError('The connected images are unavailable.'); });
    return () => { active = false; };
  }, [projectId, targetId, link.id, revision, offset]);
  return <>
    <label>Connected image <span>· {title}</span>
      <select value={selected?.selection.versionId ?? ''} disabled={!page} onChange={event => {
        const asset = page?.items.find(item => item.versionId === event.currentTarget.value);
        if (page && asset && !('relativePath' in asset)) {
          onPick({ selection: { linkId: link.id, versionId: asset.versionId, sourceRevision: page.sourceRevision }, asset });
        }
      }}>
        <option value="" disabled>Choose a version</option>
        {page?.items.map(item => <option key={item.versionId} value={item.versionId}>{item.name}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
    {page && page.total > pageSize && <div className="file-actions">
      <span>{offset + 1}–{offset + page.items.length} of {page.total} images</span>
      <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous images</button>
      <button type="button" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset ?? offset)}>Next images</button>
    </div>}
  </>;
}

function StepFields({ operation, onChange }: { operation: EditorOperation; onChange: (value: EditorOperation) => void }) {
  const update = (key: string, value: number) => onChange({ ...operation, [key]: value });
  function field(key: string, label: string, value: number, min: number, max: number) {
    return <label>{label}<input type="number" min={min} max={max} step={1}
      value={Number.isNaN(value) ? '' : value} onChange={event => update(key, event.currentTarget.valueAsNumber)} /></label>;
  }
  switch (operation.kind) {
    case 'crop': return <div className="editor-fields">
      {field('x', 'Left (px)', operation.x, 0, 8191)}{field('y', 'Top (px)', operation.y, 0, 8191)}
      {field('width', 'Width (px)', operation.width, 1, 8192)}{field('height', 'Height (px)', operation.height, 1, 8192)}
    </div>;
    case 'resize': return <div className="editor-fields">
      {field('width', 'Width (px)', operation.width, 1, 8192)}{field('height', 'Height (px)', operation.height, 1, 8192)}
    </div>;
    case 'exposure': return <label>Exposure (EV)<input type="number" min={-4} max={4} step={0.25}
      value={Number.isNaN(operation.quarterStops) ? '' : operation.quarterStops / 4}
      onChange={event => update('quarterStops', event.currentTarget.valueAsNumber * 4)} /></label>;
    case 'color': return <div className="editor-fields">
      {field('red', 'Red (%)', operation.red, 0, 200)}{field('green', 'Green (%)', operation.green, 0, 200)}
      {field('blue', 'Blue (%)', operation.blue, 0, 200)}
    </div>;
  }
}

function parameterError(steps: EditorStep[]) {
  for (const { operation } of steps) {
    if (operation.kind === 'exposure') {
      if (!Number.isInteger(operation.quarterStops) || Math.abs(operation.quarterStops) > 16) return 'Enter exposure in quarter stops from -4 to +4 EV.';
    } else if (operation.kind === 'color') {
      if ([operation.red, operation.green, operation.blue].some(value => !Number.isInteger(value) || value < 0 || value > 200)) return 'Enter channel gains from 0 to 200 percent.';
    } else {
      const { width, height } = operation;
      if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 8192) || width * height > 12_000_000) {
        return 'Use dimensions from 1 to 8192 pixels per edge and up to 12 million pixels.';
      }
      if (operation.kind === 'crop' && [operation.x, operation.y].some(value => !Number.isInteger(value) || value < 0 || value >= 8192)) return 'Enter a crop origin from 0 to 8191 pixels.';
    }
  }
  return '';
}

export default function EditorPlain({ projectId, targetId, document, revision, links, nodes, busy, onDirty, onSave, onExport }: Props) {
  const api = window.forge?.project;
  const [draft, setDraft] = useState<EditorStep[]>();
  const [picked, setPicked] = useState<Choice>();
  const [preview, setPreview] = useState<{ image: EditorPreview; fingerprint: string }>();
  const [job, setJob] = useState<'preview' | 'export'>();
  const operation = useRef<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [format, setFormat] = useState<EditorFormat>('png');
  const [name, setName] = useState('Edited image');
  const source = picked?.asset ?? document.recipe?.source;
  const inputLink = links.find(link => link.target.nodeId === targetId && link.target.portId === 'images');
  const steps = draft ?? ordered(document.recipe?.graph);
  const graph = graphOf(steps);
  const fingerprint = JSON.stringify([source?.versionId, graph]);
  const previewCurrent = preview?.fingerprint === fingerprint;
  const dirty = draft !== undefined || picked !== undefined;
  const invalid = picked && inputLink?.id !== picked.selection.linkId ? 'Choose the image again from its connected source.' : parameterError(steps);
  const available = Boolean(source && !invalid && !busy && !job);
  const input = { projectId, targetId, baseRevision: revision };

  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => {
    if (operation.current) void api?.cancelAnalysis({ projectId, operationId: operation.current }).catch(() => {});
  }, [api, projectId]);

  function update(values: EditorStep[]) {
    setDraft(values);
    setError('');
    setStatus('');
  }

  function move(index: number, direction: -1 | 1) {
    const next = steps.slice();
    const other = index + direction;
    [next[index], next[other]] = [next[other], next[index]];
    update(next);
  }

  function add(kind: EditorOperation['kind']) {
    const defaults = previewCurrent ? preview?.image : undefined;
    const operation: EditorOperation = kind === 'crop' ? { kind, x: 0, y: 0, width: defaults?.width ?? 1, height: defaults?.height ?? 1 }
      : kind === 'resize' ? { kind, width: defaults?.width ?? 512, height: defaults?.height ?? 512 }
      : kind === 'exposure' ? { kind, quarterStops: 0 }
      : { kind, red: 100, green: 100, blue: 100 };
    update([...steps, { id: crypto.randomUUID(), input: null, operation }]);
  }

  async function run(next: 'preview' | 'export', repeatVersion?: string, outputFormat = format) {
    if (!api || operation.current) return;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setJob(next);
    setError('');
    setStatus('');
    try {
      if (next === 'preview') {
        const result = await api.editorPreview({ ...input, operationId, graph, selection: picked?.selection });
        if (result.ok) {
          setPreview({ image: result.value, fingerprint });
        } else if (result.error.code === 'CANCELLED') setStatus('Preview cancelled.');
        else setError(result.error.message);
      } else {
        const result = await onExport({ ...input, operationId, name, format: outputFormat, repeatVersion });
        if (result.ok) setStatus(result.value ? 'Exported ' + result.value.items[0].name + ' to Space.' : 'Export cancelled.');
        else if (result.error.code === 'CANCELLED') setStatus('Export cancelled.');
        else setError(result.error.message);
      }
    } catch { setError('Forge could not finish this Editor operation.'); }
    finally { operation.current = undefined; setJob(undefined); }
  }

  return <section className="panel editor-panel" aria-label="Image Editor">
    <div className="editor-layout">
      <div>
        <ol className="editor-flow" aria-label="Processing graph">
          <li><fieldset disabled={busy || Boolean(job)}>
            <legend>Input</legend>
            {inputLink && <SourceChooser key={inputLink.id} {...input} link={inputLink} revision={revision} selected={picked}
              title={nodes.find(node => node.id === inputLink.source.nodeId)?.title ?? 'Linked images'}
              onPick={choice => { setPicked(choice); setError(''); setStatus(''); }} />}
            {source ? <div><strong>{source.name}</strong><p className="history-meta">Version <code>{source.versionId}</code></p></div>
              : <p>Connect an image file or Gallery in Links and select a version.</p>}
          </fieldset></li>
          {steps.map((step, index) => <li key={step.id}><fieldset disabled={busy || Boolean(job)}>
            <legend>{labels[step.operation.kind]}</legend>
            <StepFields operation={step.operation} onChange={operation => update(steps.map(item => item.id === step.id ? { ...item, operation } : item))} />
            <div className="file-actions">
              <button disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
              <button disabled={index === steps.length - 1} onClick={() => move(index, 1)}>Move down</button>
              <button onClick={() => update(steps.filter(item => item.id !== step.id))}>Remove node</button>
            </div>
          </fieldset></li>)}
          <li><fieldset disabled={busy || Boolean(job)}>
            <legend>Add processing node</legend>
            <div className="file-actions">{(Object.keys(labels) as EditorOperation['kind'][]).map(kind =>
              <button key={kind} disabled={steps.length >= 12} onClick={() => add(kind)}>Add {labels[kind]}</button>)}</div>
          </fieldset></li>
        </ol>
        {invalid && <p role="status">{invalid}</p>}
        <div className="file-actions">
          <button className="primary" disabled={!available || !dirty} onClick={() => onSave(graph, picked?.selection, () => {
            setDraft(undefined); setPicked(undefined); setStatus('Recipe saved.');
          })}>Save recipe</button>
          <button disabled={busy || Boolean(job) || !dirty} onClick={() => {
            setDraft(undefined); setPicked(undefined); setError(''); setStatus('Draft discarded.');
          }}>Discard recipe changes</button>
        </div>
      </div>
      <div className="editor-results">
        <section aria-label="Preview">
          <h3>Preview</h3>
          <button disabled={!available} onClick={() => { void run('preview'); }}>Render preview</button>
          {preview && <figure>
            <figcaption>{previewCurrent ? 'Preview' : 'Previous preview'} · {preview.image.width} × {preview.image.height} px</figcaption>
            <img alt="Edited image preview" src={preview.image.src} />
          </figure>}
        </section>
        <fieldset disabled={busy || Boolean(job)}>
          <legend>Output</legend>
          <label>Output name<input maxLength={96} value={name} onChange={event => setName(event.currentTarget.value)} /></label>
          <label>Output format<select value={format} onChange={event => setFormat(event.currentTarget.value as EditorFormat)}>
            <option value="png">PNG</option><option value="jpeg">JPEG</option>
          </select></label>
          <button disabled={!document.recipe || dirty || !name.trim()} onClick={() => { void run('export'); }}>Export image</button>
        </fieldset>
        {job && <div className="file-actions">
          <span role="status">{job === 'preview' ? 'Rendering preview…' : 'Preparing export…'}</span>
          <button onClick={() => { if (operation.current) void api?.cancelAnalysis({ projectId, operationId: operation.current }).catch(() => {}); }}>
            {job === 'preview' ? 'Cancel preview' : 'Cancel export'}
          </button>
        </div>}
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        {document.exports.length > 0 && <section aria-label="Export history">
          <h3>Export history</h3>
          <ul className="project-list">{document.exports.map(entry => <li key={entry.asset.versionId}>
            <div><strong>{entry.asset.name}</strong><p className="history-meta">Input <code>{entry.recipe.source.versionId}</code></p></div>
            <button disabled={busy || Boolean(job) || dirty || !name.trim()} onClick={() => {
              void run('export', entry.asset.versionId, entry.asset.format);
            }}>Repeat export</button>
          </li>)}</ul>
        </section>}
      </div>
    </div>
  </section>;
}

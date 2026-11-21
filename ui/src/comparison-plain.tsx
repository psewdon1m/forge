import React, { useEffect, useState } from 'react';
import { AnalysisActions, AnalysisHistory, ResultProvenance, useAnalysis, type AnalysisPlainProps } from './analysis-plain';
import { imageFormat } from './data-links';
import type {
  AnalysisTarget, ComparisonChoice, ComparisonChoices, ComparisonLines, ComparisonSelection,
  ComparisonSummary, DataLink,
} from './project-api';

type Side = 'left' | 'right' | 'difference';
type Picked = { choice: ComparisonChoice; selection: ComparisonSelection; graphRevision: number };
type SourceOption = { id: string; label: string };
const choicePageSize = 24;
const diffPageSize = 60;
const choiceId = (item: ComparisonChoice) => item.asset?.versionId ?? 'note';

function SourcePicker({ projectId, targetId, side, sources, initialSource, revision, refresh, disabled, picked, onPick }:
  AnalysisTarget & {
    side: 'Left' | 'Right'; sources: SourceOption[]; initialSource: string; revision: number; refresh: number; disabled: boolean;
    picked?: Picked; onPick: React.Dispatch<React.SetStateAction<Picked | undefined>>;
  }) {
  const [source, setSource] = useState(initialSource);
  const [request, setRequest] = useState<{ offset: number; sourceRevision?: string }>({ offset: 0 });
  const [choices, setChoices] = useState<ComparisonChoices>();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setChoices(undefined);
    setError('');
    if (source) {
      void window.forge?.project.comparisonChoices({ projectId, targetId, linkId: source, ...request, limit: choicePageSize }).then(reply => {
        if (!active) return;
        if (reply.ok) {
          setChoices(reply.value);
          onPick(value => value?.selection.sourceRevision === reply.value.sourceRevision ? value : undefined);
        } else {
          setError(reply.error.message);
          onPick(undefined);
          if (reply.error.code === 'SOURCE_CHANGED' && request.sourceRevision) setRequest({ offset: 0 });
        }
      }).catch(() => { if (active) setError('The connected source is unavailable.'); });
    }
    return () => { active = false; };
  }, [projectId, targetId, source, request, revision, refresh, onPick]);

  const items = choices?.items ?? [];
  const selected = picked?.choice;
  const options = selected && !items.some(item => choiceId(item) === choiceId(selected)) ? [selected, ...items] : items;
  return <fieldset className="comparison-picker" disabled={disabled}>
    <legend>{side}</legend>
    <label>{side} source
      <select value={source} onChange={event => {
        setSource(event.target.value);
        setRequest({ offset: 0 });
        onPick(undefined);
      }}>
        <option value="">Choose source</option>
        {sources.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
      </select>
    </label>
    <label>{side} item
      <select value={selected ? choiceId(selected) : ''} disabled={!choices} onChange={event => {
        const choice = options.find(item => choiceId(item) === event.target.value);
        onPick(choice && choices ? {
          choice, graphRevision: revision,
          selection: { linkId: source, sourceRevision: choices.sourceRevision, versionId: choice.asset?.versionId ?? null },
        } : undefined);
      }}>
        <option value="">Choose item</option>
        {options.map(item => <option value={choiceId(item)} key={choiceId(item)}>{item.name}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
    {choices?.total === 0 && <p>This source has no items.</p>}
    {!!choices?.unavailableCount && <p>{choices.unavailableCount} entries unavailable</p>}
    {choices && choices.total > choicePageSize && <div className="file-actions">
      <span>{request.offset + 1}–{request.offset + choices.items.length} of {choices.total}</span>
      {request.offset > 0 && <button onClick={() => setRequest({ offset: Math.max(0, request.offset - choicePageSize), sourceRevision: choices.sourceRevision })}>Previous {side.toLowerCase()} items</button>}
      {choices.nextOffset !== null && <button onClick={() => setRequest({ offset: choices.nextOffset!, sourceRevision: choices.sourceRevision })}>Next {side.toLowerCase()} items</button>}
    </div>}
  </fieldset>;
}

function DiffView({ projectId, targetId, summary }: AnalysisTarget & { summary: ComparisonSummary }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ComparisonLines>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError('');
    void window.forge?.project.comparisonLines({ projectId, targetId, resultId: summary.id, offset, limit: diffPageSize }).then(reply => {
      if (!active) return;
      if (reply.ok) setPage(reply.value);
      else setError(reply.error.message);
    }).catch(() => { if (active) setError('The text comparison is unavailable.'); });
    return () => { active = false; };
  }, [projectId, targetId, summary.id, offset]);
  return <section aria-label="Text comparison">
    {summary.pair.some(({ choice }) => isDocument(choice.asset?.format)) && <p>Comparing extracted document text.</p>}
    <p>{summary.added || summary.removed ? `${summary.added} added · ${summary.removed} removed` : 'No line changes.'}</p>
    {summary.alignmentLimited && <p>The changed block exceeded the line alignment limit.</p>}
    {error && <p role="alert">{error}</p>}
    {page && page.total > 0 && <div role="region" aria-label="Diff lines" tabIndex={0} className="comparison-table-scroll">
      <table className="comparison-diff">
        <thead><tr><th scope="col">Left</th><th scope="col">Right</th><th scope="col">Change</th><th scope="col">Text</th></tr></thead>
        <tbody>{page.lines.map((line, index) => <tr key={offset + index} className={'diff-' + line.kind}>
          <td>{line.leftLine}</td><td>{line.rightLine}</td>
          <td aria-label={line.kind}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</td>
          <td><code>{line.text}</code>{!line.terminated && <small> No final newline</small>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {page && page.total > diffPageSize && <div className="file-actions">
      <span>{offset + 1}–{offset + page.lines.length} of {page.total} rows</span>
      {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - diffPageSize))}>Previous diff rows</button>}
      {page.nextOffset !== null && <button onClick={() => setOffset(page.nextOffset!)}>Next diff rows</button>}
    </div>}
  </section>;
}

function ComparedImage({ projectId, targetId, resultId, side, name }: AnalysisTarget & { resultId: string; side: Side; name: string }) {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.forge?.project.comparisonPreview({ projectId, targetId, resultId, side }).then(reply => {
      if (!active) return;
      if (reply.ok && reply.value.kind === 'image') setSrc(reply.value.src);
      else setError(reply.ok ? 'Image unavailable.' : reply.error.message);
    }).catch(() => { if (active) setError('Image unavailable.'); });
    return () => { active = false; };
  }, [projectId, targetId, resultId, side]);
  return <figure>
    <figcaption>{name}</figcaption>
    {src ? <img alt={name} src={src} /> : <p role={error ? 'status' : undefined}>{error || 'Loading image…'}</p>}
  </figure>;
}

function compareMode(choice: ComparisonChoice) {
  if (!choice.asset) return 'text';
  const format = choice.asset.format;
  if (format === 'txt' || format === 'md' || isDocument(format)) return 'text';
  return format && imageFormat(format) ? 'images' : undefined;
}

function isDocument(format?: string | null) {
  return format === 'docx' || format === 'pdf';
}

function selectionProblem(left: Picked, right: Picked, links: DataLink[]) {
  const a = left.selection;
  const b = right.selection;
  const sameNote = !a.versionId && !b.versionId &&
    links.find(link => link.id === a.linkId)?.source.nodeId === links.find(link => link.id === b.linkId)?.source.nodeId;
  if (a.versionId && a.versionId === b.versionId || sameNote) return 'Choose two different items to compare.';
  const mode = compareMode(left.choice);
  if (!mode || mode !== compareMode(right.choice)) return 'Choose two text sources (note, TXT, Markdown, DOCX or PDF), or two images.';
  const assets = [left.choice.asset, right.choice.asset];
  if (mode === 'text' && assets.some(asset => asset && !isDocument(asset.format) && asset.bytes > 256 * 1024)) {
    return 'TXT and Markdown comparison supports up to 256 KiB per file.';
  }
  if (mode === 'text' && assets.some(asset => asset && isDocument(asset.format) && asset.bytes > 8 * 1024 * 1024)) {
    return 'DOCX and PDF comparison supports up to 8 MiB per file.';
  }
  if (mode === 'images' && assets.some(asset => (asset?.bytes ?? 0) > 128 * 1024 * 1024)) {
    return 'Image comparison supports up to 128 MiB per file.';
  }
  return '';
}

function ImageComparison({ projectId, targetId, summary }: AnalysisTarget & { summary: ComparisonSummary }) {
  const pixel = summary.pixelComparison;
  return <>
    <div className="comparison-grid comparison-images" aria-label="Image comparison" role="region">
      <ComparedImage projectId={projectId} targetId={targetId} resultId={summary.id} side="left" name={summary.pair[0].choice.name} />
      <ComparedImage projectId={projectId} targetId={targetId} resultId={summary.id} side="right" name={summary.pair[1].choice.name} />
    </div>
    {pixel?.state === 'dimensionsDiffer' && <p>The images have different dimensions. They are shown side by side.</p>}
    {pixel?.state === 'pixelLimit' && <p>Images above 4 million pixels are shown side by side.</p>}
    {pixel?.state === 'compared' && <section className="comparison-images" aria-label="Pixel difference">
      <h4>Pixel difference</h4>
      <p>{pixel.changedPixels} of {pixel.width * pixel.height} pixels differ · {pixel.width} × {pixel.height}</p>
      <ComparedImage projectId={projectId} targetId={targetId} resultId={summary.id} side="difference" name="Difference mask" />
      <p>Dark pixels mark differences.</p>
    </section>}
  </>;
}

export function ComparisonPlain(props: AnalysisPlainProps & { links: DataLink[]; nodes: { id: string; title: string }[] }) {
  const { projectId, targetId, revision, links, nodes } = props;
  const api = window.forge?.project;
  const analysis = useAnalysis(props, api?.comparisonStatus);
  const [leftPick, setLeft] = useState<Picked>();
  const [rightPick, setRight] = useState<Picked>();
  const connected = links.filter(link => link.target.nodeId === targetId);
  const sources = connected.map(link => ({
    id: link.id, label: (nodes.find(node => node.id === link.source.nodeId)?.title ?? 'Unavailable source') + ' · ' + link.source.portId,
  }));
  const visible = (pick?: Picked) => pick?.graphRevision === revision && connected.some(link => link.id === pick.selection.linkId) ? pick : undefined;
  const [left, right] = [visible(leftPick), visible(rightPick)];
  const problem = left && right ? selectionProblem(left, right, connected) : '';
  const result = analysis.result;
  return <section className="panel comparison-panel" aria-label="Comparison analysis">
    {sources.length > 0 && <div className="comparison-grid">
      <SourcePicker key={'left:' + revision} projectId={projectId} targetId={targetId} sources={sources} initialSource={sources[0].id}
        side="Left" revision={revision} refresh={analysis.refresh} disabled={analysis.running} picked={left} onPick={setLeft} />
      <SourcePicker key={'right:' + revision} projectId={projectId} targetId={targetId} sources={sources} initialSource={sources[1]?.id ?? sources[0].id}
        side="Right" revision={revision} refresh={analysis.refresh} disabled={analysis.running} picked={right} onPick={setRight} />
    </div>}
    {problem && <p role="status">{problem}</p>}
    {left && right && !problem && compareMode(left.choice) === 'images' && <p>Pixel differences are available for matching dimensions up to 4 million pixels.</p>}
    <AnalysisActions analysis={{ ...analysis, canRun: !!(analysis.ready && left && right && !problem) }} onRun={() => {
      if (api && left && right) void analysis.run(input => api.runComparison({ ...input, left: left.selection, right: right.selection }));
    }} />
    {analysis.history && <AnalysisHistory key={analysis.refresh} projectId={projectId} targetId={targetId} label="Comparison history"
      selected={analysis.selected?.id} onSelect={analysis.setSelected} read={api?.comparisonHistory}
      describe={entry => entry.pair.map(item => item.choice.name).join(' ↔ ')} />}
    {analysis.selected && <p>Historical result</p>}
    {result && <section aria-label="Comparison result" key={result.id}>
      <h3>{result.pair[0].choice.name} ↔ {result.pair[1].choice.name}</h3>
      {result.mode === 'text' ? <DiffView projectId={projectId} targetId={targetId} summary={result} />
        : <ImageComparison key={revision + ':' + analysis.refresh} projectId={projectId} targetId={targetId} summary={result} />}
      <ResultProvenance summary={result}>
        <dt>Right source revision</dt><dd><code>{result.pair[1].source.revision}</code></dd>
        {result.pair.map(({ choice }, index) => choice.asset && <React.Fragment key={choice.asset.versionId}>
          <dt>{index === 0 ? 'Left' : 'Right'} file version</dt><dd><code>{choice.asset.versionId}</code></dd>
        </React.Fragment>)}
      </ResultProvenance>
    </section>}
  </section>;
}

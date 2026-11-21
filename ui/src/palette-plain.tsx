import React, { useEffect, useState } from 'react';
import { AnalysisActions, AnalysisHistory, ResultProvenance, useAnalysis, type AnalysisPlainProps } from './analysis-plain';
import type { AnalysisTarget, PaletteColors, PalettePage, PaletteSummary, Swatch } from './project-api';

function Swatches({ swatches }: { swatches: Swatch[] }) {
  if (swatches.length === 0) return <p>No visible colors.</p>;
  return <ul className="palette-swatches">{swatches.map(swatch => <li key={swatch.hex}>
    <span className="palette-color" aria-hidden="true" style={{ backgroundColor: swatch.hex }} />
    <code>{swatch.hex}</code><span>{(swatch.basisPoints / 100).toFixed(2)}%</span>
  </li>)}</ul>;
}

function PaletteFiles({ projectId, targetId, resultId }: AnalysisTarget & { resultId: string }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<PalettePage>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setError('');
    void window.forge?.project.paletteFiles({ projectId, targetId, resultId, offset, limit: 12 }).then(reply => {
      if (!active) return;
      if (reply.ok) setPage(reply.value);
      else setError(reply.error.message);
    }).catch(() => { if (active) setError('File palettes are unavailable.'); });
    return () => { active = false; };
  }, [projectId, targetId, resultId, offset]);
  return <section aria-label="File palettes">
    {error && <p role="alert">{error}</p>}
    {page?.files.map(file => <div className="palette-file" key={file.asset.versionId}>
      <h4>{file.asset.name}</h4>
      <Swatches swatches={file.swatches} />
      <p className="history-meta">Version <code>{file.asset.versionId}</code></p>
    </div>)}
    {page?.total === 0 && <p>There are no images in this result.</p>}
    <div className="file-actions">
      {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - 12))}>Previous palettes</button>}
      {page && page.nextOffset !== null && <button onClick={() => setOffset(page.nextOffset!)}>Next palettes</button>}
    </div>
  </section>;
}

function ResultView({ summary, projectId, targetId }: AnalysisTarget & { summary: PaletteSummary }) {
  const [showFiles, setShowFiles] = useState(false);
  return <section aria-label="Palette result">
    <h3>Aggregate palette</h3>
    <Swatches swatches={summary.aggregate} />
    <p>{summary.itemCount} {summary.itemCount === 1 ? 'image' : 'images'}{summary.transparentCount > 0 ? ` · ${summary.transparentCount} fully transparent` : ''}</p>
    {!!summary.skippedVideos && <p>{summary.skippedVideos} {summary.skippedVideos === 1 ? 'video' : 'videos'} skipped</p>}
    <button aria-expanded={showFiles} onClick={() => setShowFiles(!showFiles)}>{showFiles ? 'Hide file palettes' : 'Show file palettes'}</button>
    {showFiles && <PaletteFiles projectId={projectId} targetId={targetId} resultId={summary.id} />}
    <ResultProvenance summary={summary}>
      <dt>Target color count</dt><dd>{summary.colors}</dd>
    </ResultProvenance>
  </section>;
}

export function PalettePlain(props: AnalysisPlainProps) {
  const { projectId, targetId } = props;
  const api = window.forge?.project;
  const analysis = useAnalysis(props, api?.paletteStatus);
  const [choice, setChoice] = useState<PaletteColors>();
  const colors = choice ?? analysis.latest?.colors ?? 4;
  const result = analysis.result;
  return <section className="panel" aria-label="Palette analysis">
    <AnalysisActions analysis={analysis} onRun={() => {
      if (api) void analysis.run(input => api.runPalette({ ...input, colors }));
    }}>
      <label>Colors <select value={colors} disabled={analysis.running} onChange={event => setChoice(Number(event.target.value) as PaletteColors)}>
        <option value={4}>4</option><option value={8}>8</option><option value={16}>16</option>
      </select></label>
    </AnalysisActions>
    {analysis.history && <AnalysisHistory key={analysis.refresh} projectId={projectId} targetId={targetId} label="Palette history"
      selected={analysis.selected?.id} onSelect={analysis.setSelected} read={api?.paletteHistory} describe={summary => summary.colors + ' colors'} />}
    {analysis.selected && <p>Historical result</p>}
    {result && <ResultView key={result.id} projectId={projectId} targetId={targetId} summary={result} />}
  </section>;
}

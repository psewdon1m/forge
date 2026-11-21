import React, { useEffect, useState } from 'react';
import { AnalysisActions, AnalysisHistory, ResultProvenance, useAnalysis, type AnalysisPlainProps } from './analysis-plain';
import type { AnalysisTarget, ExifLocation, MetadataFile, MetadataPage, MetadataSummary } from './project-api';

type ResultSelection = AnalysisTarget & { resultId: string };
const pageSize = 24;

function LocationField({ projectId, targetId, resultId, versionId }: ResultSelection & { versionId: string }) {
  const [location, setLocation] = useState<ExifLocation>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  async function toggle() {
    if (location) {
      setLocation(undefined);
      return;
    }
    const api = window.forge?.project;
    if (!api || pending) return;
    setPending(true);
    setMessage('');
    try {
      const reply = await api.metadataLocation({ projectId, targetId, resultId, versionId });
      if (!reply.ok) setMessage(reply.error.message);
      else if (reply.value) setLocation(reply.value);
      else setMessage('No EXIF location is available.');
    } catch {
      setMessage('Forge Core could not read the EXIF location.');
    } finally {
      setPending(false);
    }
  }

  return <section aria-label="EXIF location">
    <button aria-expanded={!!location} disabled={pending} onClick={() => void toggle()}>
      {location ? 'Hide EXIF location' : pending ? 'Reading EXIF location…' : 'Show EXIF location'}
    </button>
    {message && <p role="status">{message}</p>}
    {location && <dl className="analysis-provenance">
      <dt>Latitude</dt><dd>{location.latitude.toFixed(6)}°</dd>
      <dt>Longitude</dt><dd>{location.longitude.toFixed(6)}°</dd>
    </dl>}
  </section>;
}

function FileFields({ file, selection, canReveal }: { file: MetadataFile; selection: ResultSelection; canReveal: boolean }) {
  const { asset, image } = file;
  return <section aria-label="Selected file fields" className="metadata-fields">
    <h4>{asset.name}</h4>
    <dl className="analysis-provenance">
      <dt>Format</dt><dd>{asset.format?.toUpperCase() ?? 'Other'}</dd>
      <dt>Size</dt><dd>{asset.bytes.toLocaleString()} bytes</dd>
      <dt>{'relativePath' in asset ? 'File ID' : 'Asset ID'}</dt><dd><code>{asset.assetId}</code></dd>
      <dt>Version</dt><dd><code>{asset.versionId}</code></dd>
      <dt>File SHA-256</dt><dd><code>{asset.sha256 ?? 'Unavailable'}</code></dd>
      {(asset.format === 'txt' || asset.format === 'md') && !file.issue &&
        (!('relativePath' in asset) || asset.bytes <= 256 * 1024) && <><dt>Encoding</dt><dd>UTF-8</dd></>}
      {image && <>
        <dt>Dimensions</dt><dd>{image.width} × {image.height} px</dd>
        <dt>EXIF</dt><dd>{{ absent: 'None found', available: 'Available', unreadable: 'Unreadable' }[image.exif]}</dd>
        {image.fields.map(field => <React.Fragment key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></React.Fragment>)}
      </>}
    </dl>
    {file.issue && <p>{file.issue}</p>}
    {image?.locationAvailable && (canReveal
      ? <LocationField {...selection} versionId={asset.versionId} />
      : <p>EXIF location is hidden. Open the current result to view it.</p>)}
  </section>;
}

function MetadataFiles({ projectId, targetId, resultId, canReveal }: ResultSelection & { canReveal: boolean }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MetadataPage>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPage(undefined);
    setSelected(undefined);
    setError('');
    void window.forge?.project.metadataFiles({ projectId, targetId, resultId, offset, limit: pageSize }).then(reply => {
      if (!active) return;
      if (reply.ok) setPage(reply.value);
      else setError(reply.error.message);
    }).catch(() => { if (active) setError('Metadata file rows are unavailable.'); });
    return () => { active = false; };
  }, [projectId, targetId, resultId, offset]);

  const file = page?.files.find(row => row.asset.versionId === selected) ?? page?.files[0];
  return <div className="metadata-result-grid">
    <div className="metadata-table-pane">
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p>Loading files…</p>}
      {page?.total === 0 && <p>There are no files in this result.</p>}
      {page && page.total > 0 && <div className="metadata-table-scroll" tabIndex={0} role="region" aria-label="Metadata table">
        <table className="metadata-table">
          <thead><tr><th scope="col">File</th><th scope="col">Format</th><th scope="col">Bytes</th><th scope="col">Dimensions</th></tr></thead>
          <tbody>{page.files.map(row => <tr key={row.asset.versionId}>
            <td><button aria-pressed={row.asset.versionId === file?.asset.versionId} onClick={() => setSelected(row.asset.versionId)}>{row.asset.name}</button></td>
            <td>{row.asset.format?.toUpperCase() ?? 'Other'}</td>
            <td>{row.asset.bytes.toLocaleString()}</td>
            <td>{row.image ? `${row.image.width} × ${row.image.height} px` : '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <div className="file-actions">
        {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous files</button>}
        {page?.nextOffset != null && <button onClick={() => setOffset(page.nextOffset!)}>Next files</button>}
      </div>
    </div>
    {file && <FileFields key={file.asset.versionId} file={file} selection={{ projectId, targetId, resultId }} canReveal={canReveal} />}
  </div>;
}

export function MetadataPlain(props: AnalysisPlainProps) {
  const { projectId, targetId } = props;
  const api = window.forge?.project;
  const analysis = useAnalysis<MetadataSummary>(props, api?.metadataStatus);
  const result = analysis.result;
  const canReveal = !analysis.selected && analysis.sourceChecked && !analysis.running && !analysis.error && analysis.checked?.state === 'current';
  return <section className="panel metadata-panel" aria-label="Metadata analysis">
    <AnalysisActions analysis={analysis} onRun={() => { if (api) void analysis.run(input => api.runMetadata(input)); }} />
    {analysis.history && <AnalysisHistory key={analysis.refresh} projectId={projectId} targetId={targetId} label="Metadata history"
      selected={analysis.selected?.id} onSelect={analysis.setSelected} read={api?.metadataHistory}
      describe={summary => summary.itemCount + (summary.itemCount === 1 ? ' file' : ' files')} />}
    {analysis.selected && <p>Historical result</p>}
    {result && <section aria-label="Metadata result">
      <h3>{result.itemCount} {result.itemCount === 1 ? 'file' : 'files'}</h3>
      {!!result.unavailableCount && <p>{result.unavailableCount} entries unavailable in the source.</p>}
      <MetadataFiles key={result.id} projectId={projectId} targetId={targetId} resultId={result.id} canReveal={canReveal} />
      <ResultProvenance summary={result} />
    </section>}
  </section>;
}

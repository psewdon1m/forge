import React, { useEffect, useState } from 'react';
import type { AssetFormat, LinkedFilePage, DataLink, DataType, LinkPort, ResearchDocument } from './project-api';

export const analysisTypes = {
  palette: 'forge.palette',
  metadata: 'forge.metadata',
  comparison: 'forge.comparison',
} as const;
export type AnalysisKind = keyof typeof analysisTypes;
export type Port = { id: string; types: DataType[] };
const fileCollections: DataType[] = ['FileCollection', 'ImageCollection'];

export function imageFormat(format: AssetFormat) {
  return format === 'png' || format === 'jpeg' || format === 'webp';
}

export function dataPorts(kind: string, format?: AssetFormat): { inputs: Port[]; outputs: Port[] } {
  if (kind === 'research') return { inputs: [{ id: 'sources', types: [...fileCollections, 'TextContent'] }], outputs: [{ id: 'sources', types: ['ResearchSources'] }] };
  if (kind === 'intelligent') return { inputs: [{ id: 'context', types: ['ColorPalette', 'ResearchSources', 'TabularData', 'TextContent'] }], outputs: [] };
  if (kind === 'editor') return { inputs: [{ id: 'images', types: ['ImageCollection'] }], outputs: [] };
  if (kind === 'site') return { inputs: [], outputs: [{ id: 'quote', types: ['TextContent'] }] };
  if (kind === 'gallery') return { inputs: [], outputs: [
    { id: 'images', types: ['ImageCollection'] }, { id: 'files', types: ['FileCollection'] },
  ] };
  if (kind === 'directory') return { inputs: [], outputs: [{ id: 'files', types: ['FileCollection'] }] };
  if (kind === 'dataset') return { inputs: [], outputs: [{ id: 'rows', types: ['TabularData'] }] };
  if (kind === 'scheme') return { inputs: [], outputs: [
    { id: 'text', types: ['TextContent'] }, { id: 'graph', types: ['GraphData'] },
  ] };
  if (kind === 'asset' && format) {
    const outputs: Port[] = [{ id: 'files', types: ['FileCollection'] }];
    if (imageFormat(format)) outputs.unshift({ id: 'images', types: ['ImageCollection'] });
    if (format === 'txt' || format === 'md') outputs.unshift({ id: 'text', types: ['TextContent'] });
    return { inputs: [], outputs };
  }
  if (kind === 'notes') return { inputs: [], outputs: [{ id: 'text', types: ['TextContent'] }] };
  if (kind === 'checklist') return { inputs: [], outputs: [
    { id: 'text', types: ['TextContent'] }, { id: 'completions', types: ['ChecklistCompletionRecords'] },
  ] };
  if (kind === 'palette') return { inputs: [{ id: 'images', types: ['ImageCollection'] }], outputs: [{ id: 'palette', types: ['ColorPalette'] }] };
  if (kind === 'metadata') return { inputs: [{ id: 'files', types: fileCollections }], outputs: [{ id: 'metadata', types: ['MetadataCollection'] }] };
  if (kind === 'comparison') return {
    inputs: [{ id: 'sources', types: [...fileCollections, 'TextContent'] }],
    outputs: [{ id: 'comparison', types: ['ComparisonResult'] }],
  };
  return { inputs: [], outputs: [] };
}

export type LinkNode = { id: string; title: string; kind: string; format?: AssetFormat; assetVersionId?: string; research?: ResearchDocument };
type LinkChoice = { key: string; endpoint: LinkPort; port: Port; label: string };

function choices(nodes: LinkNode[], direction: 'inputs' | 'outputs'): LinkChoice[] {
  return nodes.flatMap(node => dataPorts(node.kind, node.format)[direction].map(port => ({
    key: node.id + ':' + port.id,
    endpoint: { nodeId: node.id, portId: port.id },
    port,
    label: node.title + ' · ' + port.id,
  })));
}

type LinkPanelProps = {
  nodes: LinkNode[];
  links: DataLink[];
  busy: boolean;
  onConnect: (source: LinkPort, target: LinkPort) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
};

export function LinkPanel({ nodes, links, busy, onConnect, onRemove, onClose }: LinkPanelProps) {
  const [sourceKey, setSourceKey] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const outputs = choices(nodes, 'outputs');
  const inputs = choices(nodes, 'inputs');
  const source = outputs.find(item => item.key === sourceKey);
  const targets = source ? inputs.filter(item => item.endpoint.nodeId !== source.endpoint.nodeId &&
    source.port.types.some(type => item.port.types.includes(type))) : [];
  const target = targets.find(item => item.key === targetKey);
  const label = (endpoint: LinkPort) => (nodes.find(node => node.id === endpoint.nodeId)?.title ?? 'Unavailable object') + ' · ' + endpoint.portId;

  return <section className="panel link-panel" aria-label="Data Links">
    <div className="import-report-title"><h2>Data Links</h2><button onClick={onClose}>Close links</button></div>
    <form onSubmit={event => { event.preventDefault(); if (source && target && !busy) onConnect(source.endpoint, target.endpoint); }}>
      <label>Source port<select value={sourceKey} onChange={event => { setSourceKey(event.currentTarget.value); setTargetKey(''); }}>
        <option value="">Choose source</option>
        {outputs.map(item => <option key={item.key} value={item.key}>{item.label} ({item.port.types[0]})</option>)}
      </select></label>
      <label>Target port<select value={targetKey} onChange={event => setTargetKey(event.currentTarget.value)}>
        <option value="">Choose compatible target</option>
        {targets.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>
      <button className="primary" disabled={!source || !target || busy}>Connect</button>
    </form>
    {links.length > 0 && <ul className="project-list">{links.map(link => <li key={link.id}>
      <div><strong>{label(link.source)} → {label(link.target)}</strong><br />
        <span>{link.dataType} · read-only{outputs.some(port => port.key === link.source.nodeId + ':' + link.source.portId)
          && inputs.some(port => port.key === link.target.nodeId + ':' + link.target.portId) ? '' : ' · unavailable'}</span>
      </div>
      <button disabled={busy} onClick={() => onRemove(link.id)}>Remove link</button>
    </li>)}</ul>}
  </section>;
}

function SourceAssets({ projectId, targetId, link }: { projectId: string; targetId: string; link: DataLink }) {
  const [assetPage, setAssetPage] = useState<LinkedFilePage>();
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState({ offset: 0, sourceRevision: undefined as string | undefined });
  useEffect(() => {
    let current = true;
    setAssetPage(undefined);
    setError('');
    void window.forge?.project.linkedAssets({ projectId, targetId, linkId: link.id, ...cursor, limit: 24 }).then(reply => {
      if (!current) return;
      if (reply.ok) setAssetPage(reply.value);
      else setError(reply.error.message);
    }).catch(() => { if (current) setError('Source unavailable'); });
    return () => { current = false; };
  }, [projectId, targetId, link.id, cursor]);
  return <>
    {error && <><p role="alert">{error}</p><button onClick={() => setCursor({ offset: 0, sourceRevision: undefined })}>Refresh files</button></>}
    {assetPage && <><p>{assetPage.total} linked files</p>
      {!!assetPage.unavailableCount && <p>{assetPage.unavailableCount} entries unavailable</p>}
      <ul className="project-list">{assetPage.items.map(asset => <li key={asset.assetId}><strong>{asset.name}</strong><span>{asset.format?.toUpperCase() ?? 'Other'} · {asset.bytes} bytes</span></li>)}</ul>
      {cursor.offset > 0 && <button onClick={() => setCursor({ offset: Math.max(0, cursor.offset - 24), sourceRevision: assetPage.sourceRevision })}>Previous files</button>}
      {assetPage.nextOffset !== null && <button onClick={() => setCursor({ offset: assetPage.nextOffset!, sourceRevision: assetPage.sourceRevision })}>Next files</button>}
    </>}
  </>;
}

function SourceText({ projectId, targetId, id }: { projectId: string; targetId: string; id: string }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void window.forge?.project.linkedText({ projectId, targetId, linkId: id }).then(reply => {
      if (!current) return;
      if (reply.ok) setText(reply.value.text);
      else setError(reply.error.message);
    }).catch(() => { if (current) setError('Source unavailable'); });
    return () => { current = false; };
  }, [projectId, targetId, id]);
  return error ? <p role="alert">{error}</p> : text === undefined ? null
    : <pre className="file-text-preview" aria-label="Linked text">{text}</pre>;
}

export function AnalysisSources({ projectId, targetId, links, nodes, showStatus = true }: {
  projectId: string; targetId: string; links: DataLink[]; nodes: LinkNode[]; showStatus?: boolean;
}) {
  const inputs = links.filter(link => link.target.nodeId === targetId);
  if (!showStatus && !inputs.length) return null;
  return <section className="panel" aria-label="Analysis sources">
    {showStatus && <p>Not calculated</p>}
    {inputs.length === 0 && <p>Connect a source in Space.</p>}
    {inputs.map(link => <section key={link.id} aria-label="Linked source">
      <strong>{nodes.find(node => node.id === link.source.nodeId)?.title ?? 'Source unavailable'}</strong>
      <p>{link.dataType}</p>
      {fileCollections.includes(link.dataType) && <SourceAssets projectId={projectId} targetId={targetId} link={link} />}
      {link.dataType === 'TextContent' && <SourceText projectId={projectId} targetId={targetId} id={link.id} />}
    </section>)}
  </section>;
}

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Background, BackgroundVariant, BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  SelectionMode, getSmoothStepPath, useEdgesState, useNodesState, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Box, Crosshair, FileText, FolderOpen, GitBranch, Globe, Grid2X2, ListChecks, Maximize,
  Minus, MousePointer2, Network, Plus, SlidersHorizontal, X,
} from 'lucide-react';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@xyflow/react/dist/style.css';
import './style.css';
import type { AssetRef, ChecklistData, DataLink, EditorDocument, EditorExportInput, GalleryItem, ImportProgress, ImportResult, LinkPort, ModelResult, ProjectChange, ProjectGroup, ProjectNode, ProjectPosition, ProjectView, ProjectViewport, RecentProject, Reply, ResearchDocument, SchemeDocument, SiteData } from './project-api';
import { ProjectHistory } from './project-history';
import { Checklist, checklistSummary, checklistType } from './checklist';
import { AssetDetails } from './asset-details';
import { DirectoryPlain, directoryType } from './directory-plain';
import { GalleryPlain, galleryType } from './gallery-plain';
import { videoFormat } from './video-player';
import { AnalysisSources, LinkPanel, analysisTypes, dataPorts, imageFormat, type AnalysisKind } from './data-links';
import { PalettePlain } from './palette-plain';
import { MetadataPlain } from './metadata-plain';
import { ComparisonPlain } from './comparison-plain';
import { BackupSettings } from './backup-settings';
import { DiagnosticsLogs } from './diagnostics-logs';
import { useSettings } from './use-settings';
import { UpdateSettings } from './update-settings';
import { NotePlain, PlainPane, useWidePlainLayout, type PlainFocusRequest } from './plain-pane';
const DatasetPlain = React.lazy(() => import('./dataset-plain').then(module => ({ default: module.DatasetPlain })));
const SchemePlain = React.lazy(() => import('./scheme-plain'));
const SitePlain = React.lazy(() => import('./site-plain'));
const ResearchPlain = React.lazy(() => import('./research-plain'));
const IntelligentPlain = React.lazy(() => import('./intelligent-plain'));
const EditorPlain = React.lazy(() => import('./editor-plain'));
const GitPlain = React.lazy(() => import('./git-plain'));
const datasetType = 'forge.dataset';
const schemeType = 'forge.scheme';
const siteType = 'forge.site';
const researchType = 'forge.research';
const intelligentType = 'forge.intelligent';
const editorType = 'forge.editor';
const gitType = 'forge.git';
const appVersion = window.forge?.build.version;
const appChannel = window.forge?.build.channel ?? 'Development';

type CardKind = 'notes' | 'asset' | 'checklist' | 'directory' | 'gallery' | 'dataset' | 'scheme' | 'site' | 'research' | 'intelligent' | 'editor' | 'git' | 'collection' | 'analysis' | AnalysisKind | 'unresolved';
type CardData = { kind: CardKind; title: string; description: string; checklist?: ChecklistData; scheme?: SchemeDocument; site?: SiteData; research?: ResearchDocument; results?: ModelResult[]; editor?: EditorDocument; images?: GalleryItem[]; asset?: AssetRef; groupId?: string };
type AddKind = 'note' | 'checklist' | 'directory' | 'gallery' | 'dataset' | 'scheme' | 'site' | 'research' | 'intelligent' | 'editor' | 'git' | AnalysisKind;
type CardNode = Node<CardData, 'card'>;
type Destination = 'Projects' | 'Space' | 'Settings' | 'Logs' | 'Documentation';

const kindLabel: Record<CardKind, string> = {
  notes: 'Note', asset: 'File', checklist: 'Checklist', directory: 'Directory', gallery: 'Gallery', dataset: 'Dataset', scheme: 'Scheme', site: 'Site', collection: 'Gallery',
  research: 'Research', intelligent: 'Intelligent', editor: 'Editor', git: 'Git', analysis: 'Palette', palette: 'Palette', metadata: 'Metadata', comparison: 'Comparison', unresolved: 'Unavailable Plain',
};
const kindIcon = {
  notes: FileText, asset: FileText, checklist: ListChecks, directory: FolderOpen, gallery: Grid2X2, dataset: Grid2X2, scheme: Network, site: Globe, collection: Grid2X2,
  research: FileText, intelligent: Network, editor: SlidersHorizontal, git: GitBranch, analysis: Network, palette: Network, metadata: ListChecks, comparison: FileText, unresolved: Box,
};
const plainTypes: Record<Exclude<AddKind, 'note'>, string> = { checklist: checklistType, directory: directoryType, gallery: galleryType, dataset: datasetType, scheme: schemeType, site: siteType, research: researchType, intelligent: intelligentType, editor: editorType, git: gitType, ...analysisTypes };
const fixture = new URLSearchParams(location.search).get('fixture');
const largeFixture = fixture === '500';
const sampleEnabled = fixture === 'sample' || largeFixture;

const sample: CardNode[] = [
  { id: 'brief', type: 'card', position: { x: 96, y: 120 }, data: { kind: 'notes', title: 'Shoot brief', description: 'Collect lighting references and establish the color direction.' } },
  { id: 'gallery', type: 'card', position: { x: 456, y: 78 }, data: { kind: 'collection', title: 'Visual references', description: 'Reference collection' } },
  { id: 'palette', type: 'card', position: { x: 804, y: 229 }, data: { kind: 'analysis', title: 'Color study', description: 'Connect an image collection to calculate dominant colors.' } },
];

function initialNodes(): CardNode[] {
  if (!sampleEnabled) return [];
  if (!largeFixture) return sample;
  return Array.from({ length: 500 }, (_, index) => ({
    id: 'element-' + index,
    type: 'card',
    position: { x: (index % 25) * 310, y: Math.floor(index / 25) * 200 },
    data: { kind: index % 2 === 0 ? 'collection' : 'analysis', title: 'Fixture ' + (index + 1), description: 'Performance fixture' },
  }));
}

function initialEdges(): Edge[] {
  if (!sampleEnabled) return [];
  if (!largeFixture) return [{ id: 'sample-link', source: 'gallery', target: 'palette', type: 'orthogonal' }];
  return Array.from({ length: 1000 }, (_, index) => {
    const source = 2 * (index % 250);
    return { id: 'edge-' + index, source: 'element-' + source, target: 'element-' + ((source + 1 + Math.floor(index / 250) * 50) % 500), type: 'orthogonal' };
  });
}

function Card({ data, selected }: NodeProps<CardNode>) {
  const Icon = kindIcon[data.kind];
  const isPortal = data.kind !== 'notes';
  const ports = dataPorts(data.kind, data.asset?.format);
  return <article className={'card' + (selected ? ' selected' : '')}>
    {data.kind === 'analysis' && <Handle type="target" position={Position.Left} />}
    <div className="card-head"><Icon size={14} aria-hidden /> {kindLabel[data.kind]} {data.groupId && <span className="group-marker">Group</span>} {isPortal && <ArrowUpRight size={15} aria-hidden />}</div>
    <div className="card-body">
      <strong>{data.title}</strong>
      <span>{data.description}</span>
    </div>
    {data.kind === 'collection' && <Handle type="source" position={Position.Right} />}
    {ports.outputs.map((port, index) => <Handle key={port.id} id={port.id} type="source" position={Position.Right}
      title={port.types[0]} style={{ top: (index + 1) * 100 / (ports.outputs.length + 1) + '%' }} />)}
    {ports.inputs.map((port, index) => <Handle key={port.id} id={port.id} type="target" position={Position.Left}
      title={port.types.join(', ')} style={{ top: (index + 1) * 100 / (ports.inputs.length + 1) + '%' }} />)}
  </article>;
}

function OrthogonalEdge(props: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({ ...props, borderRadius: 0 });
  return <BaseEdge id={props.id} path={edgePath} markerEnd={props.markerEnd} label={props.label}
    labelX={labelX} labelY={labelY} />;
}

const nodeTypes = { card: Card };
const edgeTypes = { orthogonal: OrthogonalEdge };
const defaultEdgeOptions = { type: 'orthogonal', markerEnd: { type: MarkerType.ArrowClosed, color: '#292927' } };

function projectCard(node: ProjectNode, groupId?: string): CardNode {
  const content = node.content;
  const base = { id: node.id, type: 'card' as const, position: node.position };
  if (content.kind === 'asset') {
    const { asset } = content;
    return { ...base, data: {
      kind: 'asset', title: node.label, asset, groupId,
      description: asset.format.toUpperCase() + ' · ' + new Intl.NumberFormat().format(asset.bytes) + ' bytes',
    } };
  }
  if (content.kind === 'portal' && content.typeId === checklistType && content.schemaVersion === 1) {
    const checklist = JSON.parse(content.payload) as ChecklistData;
    return { ...base, data: { title: node.label, kind: 'checklist', description: checklistSummary(checklist.items), checklist, groupId } };
  }
  if (content.kind === 'portal' && content.typeId === datasetType && content.schemaVersion === 1) {
    const { rows, columns } = JSON.parse(content.payload) as { rows: unknown[]; columns: unknown[] };
    return { ...base, data: { title: node.label, kind: 'dataset', description: rows.length + ' rows · ' + columns.length + ' columns', groupId } };
  }
  if (content.kind === 'portal' && content.typeId === schemeType && content.schemaVersion === 1) {
    const scheme = JSON.parse(content.payload) as SchemeDocument;
    return { ...base, data: {
      title: node.label, kind: 'scheme', scheme, groupId,
      description: scheme.elements.length + ' elements · ' + scheme.lines.length + ' connections',
    } };
  }
  if (content.kind === 'portal' && content.typeId === siteType && content.schemaVersion === 1) {
    const site = JSON.parse(content.payload) as SiteData;
    const { reference } = site;
    return { ...base, data: {
      title: node.label, kind: 'site', site, groupId,
      description: reference ? reference.title + ' · ' + new URL(reference.url).origin + ' · Reference saved' : 'Add an HTTPS address',
    } };
  }
  if (content.kind === 'portal' && content.typeId === directoryType && content.schemaVersion === 1) {
    return { ...base, data: { title: node.label, kind: 'directory', description: 'Project files', groupId } };
  }
  if (content.kind === 'portal' && content.typeId === researchType && content.schemaVersion === 1) {
    const research = JSON.parse(content.payload) as ResearchDocument;
    return { ...base, data: { title: node.label, kind: 'research', research, groupId,
      description: research.sources.length + ' sources · ' + research.citations.length + ' citations' } };
  }
  if (content.kind === 'portal' && content.typeId === intelligentType && content.schemaVersion === 1) {
    const { results } = JSON.parse(content.payload) as { results: ModelResult[] };
    return { ...base, data: { title: node.label, kind: 'intelligent', results, groupId,
      description: results.length ? results.length + ' saved results' : 'Review linked context and send a request' } };
  }
  if (content.kind === 'portal' && content.typeId === editorType && content.schemaVersion === 1) {
    const editor = JSON.parse(content.payload) as EditorDocument;
    return { ...base, data: { title: node.label, kind: 'editor', editor, groupId,
      description: editor.recipe ? editor.recipe.source.name + ' · ' + editor.recipe.graph.nodes.length + ' processing nodes' : 'Connect an image input' } };
  }
  if (content.kind === 'portal' && content.typeId === gitType && content.schemaVersion === 1) {
    return { ...base, data: { kind: 'git', title: node.label, description: 'Local repository', groupId } };
  }
  if (content.kind === 'portal' && content.schemaVersion === 1) {
    if (content.typeId === galleryType) {
      const { items } = JSON.parse(content.payload) as { items: GalleryItem[] };
      return { ...base, data: { title: node.label, kind: 'gallery', description: items.length + ' media items', images: items, groupId } };
    }
    const analysis = (Object.keys(analysisTypes) as AnalysisKind[]).find(kind => analysisTypes[kind] === content.typeId);
    if (analysis) return { ...base, data: { title: node.label, kind: analysis, description: { palette: 'Dominant colors', metadata: 'File properties', comparison: 'Compare two items' }[analysis], groupId } };
  }
  return {
    ...base,
    data: {
      title: node.label,
      kind: content.kind === 'note' ? 'notes' : 'unresolved',
      description: content.kind === 'note' ? content.text : content.typeId + ' · type unavailable',
      groupId,
    },
  };
}

function Workspace() {
  const [startingNodes] = useState(initialNodes);
  const [startingEdges] = useState(initialEdges);
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(startingNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(startingEdges);
  const [destination, setDestination] = useState<Destination>('Space');
  const [diagnosticHealth, setDiagnosticHealth] = useState({ recordingIssue: false, spaceLow: false });
  const [projectTitle, setProjectTitle] = useState(sampleEnabled ? 'Production workspace' : 'Untitled project');
  const [realProject, setRealProject] = useState(false);
  const [requestedTitle, setRequestedTitle] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [recentMessage, setRecentMessage] = useState('');
  const [projectMessage, setProjectMessage] = useState('');
  const [saveState, setSaveState] = useState('');
  const [pendingWrites, setPendingWrites] = useState(0);
  const [historyActions, setHistoryActions] = useState({ canUndo: false, canRedo: false });
  const [clipboard, setClipboard] = useState<{ nodes: ProjectNode[]; groups: ProjectGroup[]; links: DataLink[] }>();
  const [links, setLinks] = useState<DataLink[]>([]);
  const [linkPanel, setLinkPanel] = useState(false);
  const [archivePending, setArchivePending] = useState<{ ids: string[]; count: number }>();
  const [contextOpen, setContextOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [importReport, setImportReport] = useState<ImportResult['items']>();
  const [importProgress, setImportProgress] = useState<ImportProgress>();
  const [cancelingImport, setCancelingImport] = useState(false);
  const activeImport = useRef<{ projectId: string; operationId: string } | undefined>(undefined);
  const [dirtyPlains, setDirtyPlains] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<string>();
  const [beside, setBeside] = useState<string>();
  const [activePane, setActivePane] = useState<string>();
  const [plainFocus, setPlainFocus] = useState<PlainFocusRequest>();
  const widePlains = useWidePlainLayout();
  const settings = useSettings();
  const snap = settings.snap;
  const [zoom, setZoom] = useState(1);
  const { fitView, zoomIn, zoomOut, setViewport, screenToFlowPosition } = useReactFlow();
  const revision = useRef(0);
  const projectId = useRef('');
  const writeQueue = useRef(Promise.resolve());
  const viewportTimer = useRef<number | undefined>(undefined);
  const dragOrigins = useRef(new Map<string, ProjectPosition>());
  const plainReturnFocus = useRef<{ nodeId: string; trigger?: HTMLElement } | undefined>(undefined);
  const openSelectionButton = useRef<HTMLButtonElement>(null);
  const canvasElement = useRef<HTMLDivElement>(null);
  const openedNode = nodes.find(node => node.id === opened);
  const besideNode = nodes.find(node => node.id === beside);
  const plainNodes = [openedNode, besideNode].filter((node): node is CardNode => node !== undefined);
  const paired = plainNodes.length === 2;
  const visiblePane = plainNodes.some(node => node.id === activePane) ? activePane : plainNodes[0]?.id;
  const selected = nodes.find(node => node.selected);
  const selection = nodes.filter(node => node.selected);
  const selectedGroup = selected?.data.groupId;
  const ungroupable = selectedGroup && selection.every(node => node.data.groupId === selectedGroup);

  useLayoutEffect(() => {
    const previous = plainReturnFocus.current;
    if (opened || !previous) return;
    if (destination !== 'Space') {
      plainReturnFocus.current = undefined;
      return;
    }
    const { nodeId, trigger } = previous;
    // A hidden canvas may need a new layout before React Flow remounts its visible cards.
    let frames = 0;
    let frame: number;
    function restoreFocus() {
      const original = canvasElement.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
      const selection = trigger && trigger === openSelectionButton.current && selected?.id === nodeId ? trigger : undefined;
      const control = selection ?? original;
      control?.focus({ preventScroll: true });
      if (control && control.contains(document.activeElement)) {
        plainReturnFocus.current = undefined;
      } else if (++frames < 10) {
        frame = window.requestAnimationFrame(restoreFocus);
      } else {
        openSelectionButton.current?.focus();
        plainReturnFocus.current = undefined;
      }
    }
    frame = window.requestAnimationFrame(restoreFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [destination, opened, selected?.id]);

  const markPlainDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyPlains(current => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => window.forge?.project.onLogsHealth(setDiagnosticHealth), []);
  useEffect(() => window.forge?.updates.onRestarted(() => setDestination('Settings')), []);

  useEffect(() => {
    if (destination !== 'Projects' || !window.forge) return;
    let valid = true;
    window.forge.project.recent().then(reply => {
      if (!valid) return;
      if (reply.ok) {
        setRecent(reply.value);
        setRecentMessage('');
      } else {
        setRecentMessage('Could not read the recent projects list.');
      }
    }).catch(() => { if (valid) setRecentMessage('Could not read the recent projects list.'); });
    return () => { valid = false; };
  }, [destination, projectTitle]);

  const commit = useCallback((change: ProjectChange, applyToUi: () => void | Promise<void>, onFailure?: () => void) => {
    if (!realProject || !window.forge) {
      applyToUi();
      return;
    }
    const api = window.forge.project;
    const operationId = crypto.randomUUID();
    const savingProjectId = projectId.current;
    setSaveState('Saving');
    setPendingWrites(count => count + 1);
    writeQueue.current = writeQueue.current.then(async () => {
      const reply = await api.apply({ projectId: savingProjectId, operationId, baseRevision: revision.current, change });
      if (!reply.ok) {
        onFailure?.();
        setSaveState('Save failed · ' + reply.error.message);
        return;
      }
      revision.current = reply.value.revision;
      if (change.kind !== 'undo' && change.kind !== 'redo') setHistoryActions({ canUndo: true, canRedo: false });
      await applyToUi();
      setSaveState(reply.warning ?? 'Saved');
    }).catch(() => {
      onFailure?.();
      setSaveState('Could not confirm the save. Reopen the project to check its current revision.');
    })
      .finally(() => setPendingWrites(count => count - 1));
  }, [realProject]);

  const addObject = useCallback((kind: AddKind) => {
    const visible = screenToFlowPosition({ x: Math.min(window.innerWidth - 268, 190), y: 330 });
    const bottom = nodes.reduce((largest, node) => Math.max(largest, node.position.y + (node.measured?.height ?? 150)), visible.y - 32);
    const position = { x: visible.x, y: bottom + 32 };
    const node: ProjectNode = {
      id: crypto.randomUUID(), position, label: kind === 'note' ? 'Untitled note' : kindLabel[kind],
      content: kind === 'note' ? { kind: 'note', text: '' } : {
        kind: 'portal', plainId: crypto.randomUUID(), typeId: plainTypes[kind],
        schemaVersion: 1, payload: kind === 'dataset' ? '{"columns":[],"rows":[]}'
          : kind === 'scheme' ? '{"elements":[],"lines":[],"viewport":{"x":0,"y":0,"zoom":1}}'
          : kind === 'site' ? '{"reference":null}'
          : kind === 'research' ? '{"sources":[],"citations":[],"conclusions":[]}'
          : kind === 'intelligent' ? '{"results":[]}'
          : kind === 'editor' ? '{"recipe":null,"exports":[]}'
          : kind === 'checklist' || kind === 'gallery' ? '{"items":[]}' : '{}',
      },
    };
    commit({ kind: 'add', node }, () => setNodes(current => [
      ...current.map(item => ({ ...item, selected: false })), { ...projectCard(node), selected: true },
    ]));
  }, [commit, nodes, screenToFlowPosition, setNodes]);

  function adoptProject(view: ProjectView, warning?: string) {
    revision.current = view.revision;
    projectId.current = view.space.projectId;
    setRealProject(true);
    syncSpace(view);
    setLinkPanel(false);
    setArchivePending(undefined);
    setImportReport(undefined);
    resetPlains();
    setSaveState(warning ?? 'Saved');
    setDestination('Space');
    void setViewport(view.viewport);
  }

  function syncSpace(view: ProjectView, selectedIds = new Set<string>()) {
    const membership = new Map((view.space.groups ?? []).flatMap(group => group.members.map(id => [id, group.id] as const)));
    setProjectTitle(view.space.title);
    setRenameTitle(view.space.title);
    setNodes(view.space.nodes.map(node => ({
      ...projectCard(node, membership.get(node.id)), selected: selectedIds.has(node.id),
    })));
    setHistoryActions({ canUndo: view.canUndo, canRedo: view.canRedo });
    const graph = view.space.links ?? [];
    setLinks(graph);
    setEdges(graph.map(link => ({
      id: link.id, source: link.source.nodeId, sourceHandle: link.source.portId,
      target: link.target.nodeId, targetHandle: link.target.portId, label: link.dataType, type: 'orthogonal',
    })));
  }

  function importFiles(screen: ProjectPosition, dropToken?: string, galleryId?: string) {
    const api = window.forge?.project;
    if (!api || !realProject || pendingWrites > 0 || working || activeImport.current ||
      (opened && !plainNodes.some(node => node.id === galleryId && node.data.kind === 'gallery'))) return;
    const importingProject = projectId.current;
    const operation = { projectId: importingProject, operationId: crypto.randomUUID() };
    activeImport.current = operation;
    const position = screenToFlowPosition(screen, { snapToGrid: snap });
    setPendingWrites(count => count + 1);
    setImportReport(undefined);
    setLinkPanel(false);
    setSaveState('Importing files…');
    writeQueue.current = writeQueue.current.then(async () => {
      const reply = await api.importAssets({ ...operation, baseRevision: revision.current, position, dropToken, galleryId });
      if (!reply.ok) {
        setSaveState(reply.error.code === 'IMPORT_CANCELED' ? 'Import canceled' : 'Import failed · ' + reply.error.message);
        return;
      }
      if (!reply.value) {
        setSaveState('Import canceled');
        return;
      }
      const { items, revision: importedRevision } = reply.value;
      revision.current = importedRevision;
      setImportReport(items);
      const imported = items.filter(item => item.asset !== null).length;
      const ids = new Set(items.flatMap(item => item.nodeId ? [item.nodeId] : []));
      if (imported > 0) {
        const view = await api.view();
        if (!view.ok || view.value.space.projectId !== importingProject) {
          setSaveState('Files saved. Reopen the project to refresh Space.');
          return;
        }
        syncSpace(view.value, galleryId ? new Set([galleryId]) : ids);
      }
      setSaveState('Imported ' + imported + ' of ' + items.length + ' files');
    }).catch(() => setSaveState('Could not confirm the import. Reopen the project to check its current revision.'))
      .finally(() => {
        activeImport.current = undefined;
        setImportProgress(undefined);
        setCancelingImport(false);
        setPendingWrites(count => count - 1);
      });
  }

  useEffect(() => window.forge?.project.onImportProgress(progress => {
    if (progress.operationId === activeImport.current?.operationId) setImportProgress(progress);
  }), []);

  async function cancelImport() {
    const api = window.forge?.project;
    const operation = activeImport.current;
    if (!api || !operation || cancelingImport || importProgress?.phase !== 'copying') return;
    setCancelingImport(true);
    try {
      const reply = await api.cancelImport(operation);
      if (!reply.ok && activeImport.current === operation) {
        setCancelingImport(false);
        setSaveState(reply.error.message);
      }
    } catch {
      if (activeImport.current === operation) {
        setCancelingImport(false);
        setSaveState('Could not request cancellation');
      }
    }
  }

  useEffect(() => {
    if (destination !== 'Space' || !realProject || !window.forge) return;
    return window.forge.project.onFileDrop(({ clientX, clientY, reply, galleryId }) => {
      if (!reply.ok) setSaveState('Import failed · ' + reply.error.message);
      else importFiles({ x: clientX, y: clientY }, reply.value, galleryId);
    });
  });

  function updateFile(nodeId: string, versionId: string, change: 'replace' | 'importEdit' | { text: string }) {
    const api = window.forge?.project;
    if (!api || !realProject || pendingWrites > 0 || working) return;
    const selection = { projectId: projectId.current, nodeId, versionId };
    const messages = change === 'replace' ? {
      pending: 'Replacing file…', failed: 'Replacement failed', canceled: 'Replacement canceled', done: 'File replaced',
    } : change === 'importEdit' ? {
      pending: 'Importing edit copy…', failed: 'Edit import failed', canceled: 'Edit import canceled', done: 'Edited file saved as a new version',
    } : {
      pending: 'Saving text…', failed: 'Text save failed', canceled: 'Text save canceled', done: 'Text saved',
    };
    setPendingWrites(count => count + 1);
    setSaveState(messages.pending);
    writeQueue.current = writeQueue.current.then(async () => {
      const request = { ...selection, operationId: crypto.randomUUID(), baseRevision: revision.current };
      const result = change === 'replace' ? await api.replaceAsset(request)
        : change === 'importEdit' ? await api.importEditCopy(request)
        : await api.editTextAsset({ ...request, text: change.text });
      if (!result.ok) {
        setSaveState(messages.failed + ' · ' + result.error.message);
        return;
      }
      if (!result.value) {
        setSaveState(messages.canceled);
        return;
      }
      revision.current = result.value.revision;
      markPlainDirty(nodeId, false);
      const view = await api.view();
      if (!view.ok || view.value.space.projectId !== selection.projectId) {
        setSaveState('File saved. Reopen the project to refresh Space.');
        return;
      }
      syncSpace(view.value, new Set([nodeId]));
      setSaveState(messages.done);
    }).catch(() => setSaveState('Could not confirm the file save. Reopen the project to check its current revision.'))
      .finally(() => setPendingWrites(count => count - 1));
  }

  async function chooseProject(action: 'create' | 'open' | { recentId: string }) {
    if (!window.forge || working) return;
    setWorking(true);
    setProjectMessage('');
    try {
      await writeQueue.current;
      window.clearTimeout(viewportTimer.current);
      const api = window.forge.project;
      const result = action === 'create' ? await api.create(requestedTitle)
        : action === 'open' ? await api.open() : await api.openRecent(action.recentId);
      if (result.ok && result.value) adoptProject(result.value, result.warning);
      else if (!result.ok) setProjectMessage(result.error.message);
    } catch {
      setProjectMessage('Could not open a Forge project.');
    } finally {
      setWorking(false);
    }
  }

  async function archiveProject() {
    const api = window.forge?.project;
    if (!api || !realProject || working || pendingWrites > 0) return;
    setWorking(true);
    setProjectMessage('');
    try {
      await writeQueue.current;
      const result = await api.archive(projectId.current);
      if (!result.ok) {
        setProjectMessage(result.error.message);
        return;
      }
      if (!result.value) return;
      window.clearTimeout(viewportTimer.current);
      const archivedId = projectId.current;
      setRecent(current => current.filter(project => project.id !== archivedId));
      projectId.current = '';
      revision.current = 0;
      setRealProject(false);
      setProjectTitle('Workspace');
      setNodes([]);
      setEdges([]);
      setLinks([]);
      setClipboard(undefined);
      setHistoryActions({ canUndo: false, canRedo: false });
      setProjectMessage('Project archived. Use Open project to reopen its folder.');
    } catch {
      setProjectMessage('Could not confirm that the project was archived.');
    } finally {
      setWorking(false);
    }
  }

  function openCard(node: CardNode, trigger: HTMLElement) {
    if (activeImport.current) return;
    setLinkPanel(false);
    setArchivePending(undefined);
    plainReturnFocus.current = { nodeId: node.id, trigger };
    setOpened(node.id);
    focusPane(node.id);
    setContextOpen(false);
  }

  function focusPane(id: string) {
    setActivePane(id);
    setPlainFocus({ id });
  }

  function resetPlains() {
    setOpened(undefined);
    setBeside(undefined);
    setActivePane(undefined);
    setPlainFocus(undefined);
    setDirtyPlains(new Set());
  }

  const besideChoices = openedNode && realProject ? nodes.filter(node => node.id !== opened && node.data.kind !== 'unresolved' &&
    !(openedNode.data.kind === 'site' && node.data.kind === 'site')) : [];

  function openBeside(id: string) {
    if (!besideChoices.some(node => node.id === id) || pendingWrites > 0 || !canClosePlains(besideNode ? [besideNode] : [])) return;
    setBeside(id);
    focusPane(id);
  }

  function closePane(node: CardNode) {
    if (!paired) { leaveCard(); return; }
    if (!canClosePlains([node])) return;
    const other = plainNodes.find(item => item.id !== node.id);
    if (!other) return;
    setOpened(other.id);
    setBeside(undefined);
    focusPane(other.id);
  }

  function applySpaceChange(change: ProjectChange, preserveSelection = false) {
    const api = window.forge?.project;
    if (!api || !realProject || pendingWrites > 0 || working) return;
    const selectedIds = new Set(preserveSelection ? selection.map(node => node.id) : []);
    setContextOpen(false);
    commit(change, async () => {
      const reply = await api.view();
      if (!reply.ok) throw new Error('Could not reload project');
      syncSpace(reply.value, selectedIds);
    });
  }

  function connectPorts(source: LinkPort, target: LinkPort) {
    applySpaceChange({ kind: 'connect', id: crypto.randomUUID(), source, target }, true);
  }

  function requestArchive() {
    const ids = selection.map(node => node.id);
    const selected = new Set(ids);
    const count = links.filter(link => selected.has(link.source.nodeId) || selected.has(link.target.nodeId)).length;
    if (count) {
      setLinkPanel(false);
      setArchivePending({ ids, count });
    } else applySpaceChange({ kind: 'archiveSelection', ids });
  }

  const linkNodes = nodes.map(node => ({ id: node.id, title: node.data.title, kind: node.data.kind,
    format: node.data.asset?.format, assetVersionId: node.data.asset?.versionId, research: node.data.research }));

  async function copySelection() {
    const api = window.forge?.project;
    if (!api || !selection.length || pendingWrites > 0 || working) return;
    const copyingProject = projectId.current;
    const ids = new Set(selection.map(node => node.id));
    try {
      const reply = await api.view();
      if (!reply.ok || reply.value.space.projectId !== copyingProject) throw new Error('Selection changed');
      const copied = reply.value.space.nodes.filter(node => ids.has(node.id));
      const groups = (reply.value.space.groups ?? []).filter(group => group.members.every(id => ids.has(id)));
      const links = (reply.value.space.links ?? []).filter(link => ids.has(link.source.nodeId) && ids.has(link.target.nodeId));
      setClipboard({ nodes: copied, groups, links });
      setSaveState('Copied ' + copied.length + (copied.length === 1 ? ' object' : ' objects'));
      setContextOpen(false);
    } catch {
      setSaveState('Could not copy the selection.');
    }
  }

  function pasteSelection() {
    if (!clipboard?.nodes.length) return;
    const x = Math.min(...clipboard.nodes.map(node => node.position.x));
    const y = Math.min(...clipboard.nodes.map(node => node.position.y));
    const screen = screenToFlowPosition({ x: Math.min(window.innerWidth - 268, 530), y: 300 });
    applySpaceChange({
      kind: 'paste',
      nodes: clipboard.nodes.map(node => ({ ...node, position: { x: screen.x + node.position.x - x, y: screen.y + node.position.y - y } })),
      groups: clipboard.groups,
      links: clipboard.links,
    });
  }

  function applyNodeChanges(changes: NodeChange<CardNode>[]) {
    const groupSelection = new Map<string, boolean>();
    for (const change of changes) {
      if (change.type !== 'select') continue;
      const group = nodes.find(node => node.id === change.id)?.data.groupId;
      if (group && !groupSelection.get(group)) groupSelection.set(group, change.selected);
    }
    if (!groupSelection.size) {
      onNodesChange(changes);
      return;
    }
    const expanded = nodes.filter(node => node.data.groupId && groupSelection.has(node.data.groupId))
      .map(node => ({ type: 'select' as const, id: node.id, selected: groupSelection.get(node.data.groupId!)! }));
    onNodesChange([...changes, ...expanded]);
  }

  function startDrag() {
    dragOrigins.current = new Map(nodes.map(node => [node.id, node.position]));
  }

  function stopDrag(draggingNodes: CardNode[]) {
    const previous = dragOrigins.current;
    if (!previous.size) return;
    dragOrigins.current = new Map();
    const changed = draggingNodes.some(node => {
      const origin = previous.get(node.id);
      return origin && (origin.x !== node.position.x || origin.y !== node.position.y);
    });
    if (!changed) return;
    const positions = new Map(draggingNodes.map(node => [node.id, node.position]));
    const groupDeltas = new Map<string, ProjectPosition>();
    for (const node of draggingNodes) {
      const group = node.data.groupId;
      const origin = previous.get(node.id);
      if (group && origin && !groupDeltas.has(group)) {
        groupDeltas.set(group, { x: node.position.x - origin.x, y: node.position.y - origin.y });
      }
    }
    for (const node of nodes) {
      const delta = node.data.groupId ? groupDeltas.get(node.data.groupId) : undefined;
      const origin = previous.get(node.id);
      if (delta && origin) positions.set(node.id, { x: origin.x + delta.x, y: origin.y + delta.y });
    }
    const placements = [...positions].map(([id, position]) => ({ id, position }));
    const updatePositions = (next: Map<string, ProjectPosition>) => setNodes(current => current.map(item => {
      const position = positions.has(item.id) ? next.get(item.id) : undefined;
      return position ? { ...item, position } : item;
    }));
    commit({ kind: 'moveSelection', placements }, () => updatePositions(positions), () => updatePositions(previous));
  }

  function saveViewport(viewport: ProjectViewport) {
    if (!realProject || !window.forge) return;
    const api = window.forge.project;
    const savingProjectId = projectId.current;
    window.clearTimeout(viewportTimer.current);
    viewportTimer.current = window.setTimeout(() => {
      writeQueue.current = writeQueue.current.then(async () => {
        const result = await api.saveViewport({ projectId: savingProjectId, viewport });
        if (!result.ok) setSaveState('View save failed · ' + result.error.message);
      }).catch(() => setSaveState('View save failed.'));
    }, 2000);
  }

  function restoreRevision(selectedRevision: number) {
    const api = window.forge?.project;
    if (!api || pendingWrites > 0) return;
    commit({ kind: 'restoreRevision', revision: selectedRevision }, async () => {
      const reply = await api.view();
      if (!reply.ok) throw new Error('Could not reload restored project');
      adoptProject(reply.value);
    });
  }

  function showSample() {
    setNodes(sample.map(node => ({ ...node, data: { ...node.data }, position: { ...node.position } })));
    setEdges([{ id: 'sample-link', source: 'gallery', target: 'palette', ...defaultEdgeOptions }]);
    setProjectTitle('Production workspace');
    resetPlains();
    setDestination('Space');
  }

  function navigate(page: Destination) {
    if (activeImport.current && page !== 'Space') {
      setSaveState('Finish or cancel the file import before leaving Space.');
      return;
    }
    if (!leaveCard()) return;
    setDestination(page);
  }

  function leaveCard() {
    if (!canClosePlains(plainNodes)) return false;
    resetPlains();
    return true;
  }

  function canClosePlains(closing: CardNode[]) {
    if (pendingWrites > 0 && closing.length) return false;
    const dirty = closing.find(node => dirtyPlains.has(node.id));
    if (!dirty) return true;
    setSaveState(paired ? `Save or discard changes in ${dirty.data.title} before leaving.`
      : dirty.data.kind === 'notes' ? 'Save or discard the note changes before leaving.' : 'Save or discard the file changes before leaving.');
    return false;
  }

  async function saveProviderResult(kind: 'model' | 'transcription', targetId: string, resultId: string) {
    const api = window.forge?.project;
    if (!api) return 'Forge Core is unavailable.';
    const requestedProject = projectId.current;
    setPendingWrites(count => count + 1);
    const saving = writeQueue.current.then(async () => {
      if (requestedProject !== projectId.current) return 'Open the project again before saving.';
      const input = { projectId: requestedProject, targetId, resultId, baseRevision: revision.current, operationId: crypto.randomUUID() };
      const saved = await (kind === 'model' ? api.modelSave(input) : api.transcriptionSave(input));
      if (!saved.ok) return saved.error.message;
      revision.current = saved.value.revision;
      const next = await api.view();
      if (!next.ok || next.value.space.projectId !== requestedProject || requestedProject !== projectId.current) {
        return 'Reopen the project to check the saved result.';
      }
      revision.current = next.value.revision;
      syncSpace(next.value, new Set([targetId]));
      setSaveState('Saved');
    });
    writeQueue.current = saving.then(() => {}, () => {});
    try { return await saving; }
    finally { setPendingWrites(count => count - 1); }
  }

  async function exportEditor(input: EditorExportInput): Promise<Reply<ImportResult | null>> {
    const api = window.forge?.project;
    if (!api) return { ok: false, error: { code: 'UNAVAILABLE', message: 'Forge Core is unavailable.' } };
    setPendingWrites(count => count + 1);
    const writing = writeQueue.current.then(async (): Promise<Reply<ImportResult | null>> => {
      if (input.projectId !== projectId.current || input.baseRevision !== revision.current) {
        return { ok: false, error: { code: 'STALE_REVISION', message: 'The project changed. Review the saved recipe again.' } };
      }
      const reply = await api.editorExport(input);
      if (reply.ok && reply.value) {
        revision.current = reply.value.revision;
        const read = await api.view();
        if (!read.ok || read.value.space.projectId !== input.projectId || projectId.current !== input.projectId) {
          return { ok: false, error: { code: 'READ_FAILED', message: 'Reopen the project to check the exported image.' } };
        }
        revision.current = read.value.revision;
        syncSpace(read.value, new Set([input.targetId]));
        setSaveState('Saved');
      }
      return reply;
    });
    writeQueue.current = writing.then(() => {}, () => {});
    try { return await writing; }
    finally { setPendingWrites(count => count - 1); }
  }

  function renderPlain(node: CardNode, setPaneDirty: (dirty: boolean) => void, visible: boolean) {
    return (
      node.data.kind === 'notes'
      ? <NotePlain text={node.data.description} busy={pendingWrites > 0} onDirty={setPaneDirty}
          onDiscard={() => setSaveState('Draft discarded')} onSave={description => {
            const id = node.id;
            commit({ kind: 'editNote', id, text: description }, () => {
              setNodes(current => current.map(node => node.id === id ? { ...node, data: { ...node.data, description } } : node));
            });
          }} />
      : node.data.checklist ? <Checklist key={node.id} items={node.data.checklist.items}
        groups={node.data.checklist.groups ?? []} busy={pendingWrites > 0}
        onChange={(checklist, afterSave) => {
          const id = node.id;
          commit({ kind: 'editChecklist', id, ...checklist }, async () => {
            const result = await window.forge?.project.view();
            if (!result?.ok) throw new Error('Could not refresh checklist');
            syncSpace(result.value, new Set([id]));
            afterSave?.();
          });
        }} /> : node.data.site
        ? <React.Suspense fallback={<p role="status">Loading Site…</p>}><SitePlain key={node.id} projectId={projectId.current} nodeId={node.id}
            saved={node.data.site.reference} busy={pendingWrites > 0} onDirty={setPaneDirty}
            visible={visible}
            onSave={(site, done) => {
              const id = node.id;
              commit({ kind: 'editSite', id, site }, async () => {
                const result = await window.forge?.project.view();
                if (!result?.ok) throw new Error('Could not refresh Site');
                syncSpace(result.value, new Set([id]));
                done();
              });
            }} /></React.Suspense>
        : node.data.scheme
        ? <React.Suspense fallback={<p role="status">Loading Scheme…</p>}><SchemePlain key={node.id} projectId={projectId.current} nodeId={node.id}
            document={node.data.scheme} baseRevision={revision.current} busy={pendingWrites > 0} onDirty={setPaneDirty}
            onSave={(document, done) => {
              const id = node.id;
              commit({ kind: 'editScheme', id, document }, async () => {
                const result = await window.forge?.project.view();
                if (!result?.ok) throw new Error('Could not refresh Scheme');
                syncSpace(result.value, new Set([id]));
                done();
              });
            }} /></React.Suspense>
        : node.data.results
        ? <React.Suspense fallback={<p role="status">Loading Intelligent…</p>}><IntelligentPlain key={node.id}
            projectId={projectId.current} targetId={node.id} revision={revision.current}
            links={links} nodes={linkNodes} saved={node.data.results} onDirty={setPaneDirty}
            onSave={resultId => saveProviderResult('model', node.id, resultId)} /></React.Suspense>
        : node.data.research
        ? <React.Suspense fallback={<p role="status">Loading Research…</p>}><ResearchPlain key={node.id}
            projectId={projectId.current} targetId={node.id} document={node.data.research}
            revision={revision.current} busy={pendingWrites > 0} links={links} nodes={linkNodes} onDirty={setPaneDirty}
            onSaveTranscription={resultId => saveProviderResult('transcription', node.id, resultId)}
            onSave={(action, done) => {
              const id = node.id;
              commit({ kind: 'editResearch', id, action }, async () => {
                const result = await window.forge?.project.view();
                if (!result?.ok) throw new Error('Could not refresh Research');
                syncSpace(result.value, new Set([id]));
                done?.();
              });
            }} /></React.Suspense>
        : node.data.editor
        ? <React.Suspense fallback={<p role="status">Loading Editor…</p>}><EditorPlain key={node.id}
            projectId={projectId.current} targetId={node.id} document={node.data.editor}
            revision={revision.current} busy={pendingWrites > 0} links={links} nodes={linkNodes} onDirty={setPaneDirty}
            onExport={exportEditor} onSave={(graph, selection, done) => {
              const id = node.id;
              commit({ kind: 'editEditor', id, graph, selection }, async () => {
                const next = await window.forge?.project.view();
                if (!next?.ok) throw new Error('Could not refresh Editor');
                syncSpace(next.value, new Set([id]));
                done();
              });
            }} /></React.Suspense>
        : node.data.kind === 'git'
        ? <React.Suspense fallback={<p role="status">Loading Git…</p>}><GitPlain key={node.id} projectId={projectId.current} nodeId={node.id} onDirty={setPaneDirty} /></React.Suspense>
        : node.data.kind === 'dataset'
        ? <React.Suspense fallback={<p role="status">Loading Dataset…</p>}><DatasetPlain key={node.id} projectId={projectId.current} nodeId={node.id}
            revision={revision.current} busy={pendingWrites > 0} onDirty={setPaneDirty}
            onSave={(change, done) => {
              const id = node.id;
              commit({ id, ...change }, async () => {
                const result = await window.forge?.project.view();
                if (!result?.ok) throw new Error('Could not refresh Dataset');
                syncSpace(result.value, new Set([id]));
                done();
              });
            }} /></React.Suspense>
        : node.data.asset
        ? <AssetDetails key={`${projectId.current}:${node.id}:${node.data.asset.versionId}`}
            projectId={projectId.current} nodeId={node.id} asset={node.data.asset}
            description={node.data.description} busy={pendingWrites > 0} visible={visible}
            onReplace={(id, version) => updateFile(id, version, 'replace')}
            onSaveText={(id, version, text) => updateFile(id, version, { text })}
            onImportEdit={(id, version) => updateFile(id, version, 'importEdit')}
            onDirtyChange={setPaneDirty} />
        : node.data.kind === 'directory'
          ? <DirectoryPlain key={node.id} projectId={projectId.current} nodeId={node.id} revision={revision.current} />
          : node.data.images
            ? <GalleryPlain key={node.id} projectId={projectId.current} nodeId={node.id} items={node.data.images}
              available={nodes.flatMap(node => node.data.asset && (imageFormat(node.data.asset.format) || videoFormat(node.data.asset.format)) ? [node.data.asset] : [])}
              busy={pendingWrites > 0} visible={visible} onImport={() => importFiles({ x: 0, y: 0 }, undefined, node.id)}
              onChange={items => applySpaceChange({ kind: 'editGallery', id: node.id, items }, true)} />
            : node.data.kind === 'palette'
              ? <React.Fragment key={node.id}>
                <PalettePlain projectId={projectId.current} targetId={node.id} revision={revision.current} busy={pendingWrites > 0} />
                <AnalysisSources projectId={projectId.current} targetId={node.id} links={links} nodes={linkNodes} showStatus={false} />
              </React.Fragment>
              : node.data.kind === 'metadata'
                ? <React.Fragment key={node.id}>
                  <MetadataPlain projectId={projectId.current} targetId={node.id} revision={revision.current} busy={pendingWrites > 0} />
                  <AnalysisSources projectId={projectId.current} targetId={node.id} links={links} nodes={linkNodes} showStatus={false} />
                </React.Fragment>
              : node.data.kind === 'comparison'
                ? <ComparisonPlain key={node.id} projectId={projectId.current} targetId={node.id}
                  revision={revision.current} busy={pendingWrites > 0} links={links} nodes={linkNodes} />
                : <p>{node.data.description}</p>
    );
  }

  return <div className="app" onKeyDownCapture={event => {
    if (!realProject || opened || destination !== 'Space' || !selection.length ||
      !(event.target instanceof HTMLElement) ||
      !event.target.closest('.react-flow__node, .react-flow__nodesselection-rect, .selection')) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    if (pendingWrites > 0) return;
    const step = snap ? 16 : 1;
    const placements = selection.map(node => ({
      id: node.id, position: { x: node.position.x + step * direction[0], y: node.position.y + step * direction[1] },
    }));
    const positions = new Map(placements.map(node => [node.id, node.position]));
    commit({ kind: 'moveSelection', placements }, () => setNodes(current => current.map(node => {
      const position = positions.get(node.id);
      return position ? { ...node, position } : node;
    })));
  }} onKeyDown={event => {
    if (event.key === 'Escape') {
      if (archivePending) setArchivePending(undefined);
      else if (linkPanel) setLinkPanel(false);
      else if (opened) leaveCard();
      else if (contextOpen) setContextOpen(false);
      return;
    }
    if (opened || destination !== 'Space' || !realProject || pendingWrites > 0 ||
      (event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (key === 'z' && event.shiftKey && historyActions.canRedo) { event.preventDefault(); applySpaceChange({ kind: 'redo' }); }
      else if (key === 'z' && !event.shiftKey && historyActions.canUndo) { event.preventDefault(); applySpaceChange({ kind: 'undo' }); }
      else if (key === 'y' && historyActions.canRedo) { event.preventDefault(); applySpaceChange({ kind: 'redo' }); }
      else if (key === 'c' && selection.length) { event.preventDefault(); void copySelection(); }
      else if (key === 'v' && clipboard) { event.preventDefault(); pasteSelection(); }
    } else if (key === 'delete' && selection.length) {
      event.preventDefault();
      requestArchive();
    }
  }}>
    <header className="titlebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true" />Forge</div>
      <nav aria-label="Main navigation">
        {(['Projects', 'Space', 'Settings', 'Logs', 'Documentation'] as const).map(page =>
          <button key={page} aria-current={destination === page ? 'page' : undefined} onClick={() => navigate(page)}>{page}</button>)}
      </nav>
      <span className="version">{appVersion ? appVersion + ' · ' + appChannel : appChannel}</span>
    </header>
    {destination !== 'Logs' && diagnosticHealth.recordingIssue &&
      <p className="diagnostics-warning" role="alert">Some diagnostics could not be recorded. See Logs.</p>}
    {destination !== 'Logs' && diagnosticHealth.spaceLow &&
      <p className="diagnostics-warning" role="alert">The diagnostics drive has less than 64 MiB free.</p>}

    {destination === 'Space' && <>
      <section className="workspace-header" aria-label="Project">
        <div><div className="eyebrow">Project / Space</div><h1>{projectTitle}</h1></div>
        <div className="workspace-actions">
          {openedNode
            ? <><button onClick={leaveCard}><ArrowLeft size={15} /> Back to Space</button>
              {besideChoices.length > 0 && <select aria-label="Open beside" value={besideNode?.id ?? ''}
                disabled={working || pendingWrites > 0} onChange={event => openBeside(event.currentTarget.value)}>
                <option value="" disabled>Open beside…</option>
                {besideChoices.map(node => <option key={node.id} value={node.id}>{node.data.title} · {kindLabel[node.data.kind]}</option>)}
              </select>}
            </>
            : <>
              <button className="primary" onClick={() => addObject('note')}><Plus size={16} /> Add note</button>
              {realProject && <button onClick={() => addObject('checklist')}><ListChecks size={16} /> Add checklist</button>}
              {realProject && <button onClick={() => addObject('directory')}><FolderOpen size={16} /> Add Directory</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('gallery')}><Grid2X2 size={16} /> Add Gallery</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('dataset')}><Grid2X2 size={16} /> Add Dataset</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('scheme')}><Network size={16} /> Add Scheme</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('research')}><FileText size={16} /> Add Research</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('intelligent')}><Network size={16} /> Add Intelligent</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('editor')}><SlidersHorizontal size={16} /> Add Editor</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('git')}><GitBranch size={16} /> Add Git</button>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => addObject('site')}><Globe size={16} /> Add Site</button>}
              {realProject && <select aria-label="Add analysis" value="" disabled={pendingWrites > 0} onChange={event => {
                const kind = event.currentTarget.value;
                if (Object.hasOwn(analysisTypes, kind)) addObject(kind as AnalysisKind);
              }}><option value="">Add analysis</option>
                {Object.keys(analysisTypes).map(kind => <option key={kind} value={kind}>{kindLabel[kind as AnalysisKind]}</option>)}
              </select>}
              {realProject && <button disabled={pendingWrites > 0} onClick={() => importFiles({ x: 260, y: 310 })}><Plus size={16} /> Import files</button>}
            </>}
        </div>
      </section>
      <main className="workspace">
        <div ref={canvasElement} className="canvas" hidden={!!openedNode} aria-label="Space canvas" data-forge-file-drop={realProject && !openedNode ? '' : undefined}>
          <ReactFlow<CardNode, Edge>
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={applyNodeChanges} onEdgesChange={onEdgesChange}
            onConnect={connection => {
              if (connection.sourceHandle && connection.targetHandle) {
                connectPorts({ nodeId: connection.source, portId: connection.sourceHandle }, { nodeId: connection.target, portId: connection.targetHandle });
              }
            }}
            onNodeDoubleClick={(event, node) => openCard(node, event.currentTarget as HTMLElement)}
            onNodeClick={(event, node) => { if (event.detail === 0) openCard(node, event.currentTarget as HTMLElement); }}
            onPaneClick={() => setContextOpen(false)}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setNodes(current => current.map(item => ({
                ...item, selected: item.id === node.id || (!!node.data.groupId && item.data.groupId === node.data.groupId),
              })));
              setContextOpen(true);
            }}
            onSelectionContextMenu={event => {
              event.preventDefault();
              setContextOpen(true);
            }}
            onNodeDragStart={startDrag}
            onNodeDragStop={(_event, node, draggingNodes) => stopDrag(draggingNodes.length ? draggingNodes : [node])}
            onSelectionDragStart={startDrag}
            onSelectionDragStop={(_event, draggingNodes) => stopDrag(draggingNodes)}
            onMove={(_event, viewport) => setZoom(viewport.zoom)}
            onMoveEnd={(_event, viewport) => saveViewport(viewport)}
            onlyRenderVisibleElements snapToGrid={snap} snapGrid={[16, 16]} defaultEdgeOptions={defaultEdgeOptions}
            panOnDrag={[1, 2]} selectionOnDrag selectionMode={SelectionMode.Partial} multiSelectionKeyCode="Shift" minZoom={0.05} maxZoom={8}
            nodesDraggable={!realProject || pendingWrites === 0}
            nodesConnectable={realProject && pendingWrites === 0} deleteKeyCode={realProject ? null : ['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Lines} gap={32} color="#deded9" />
          </ReactFlow>
          {nodes.length === 0 && <section className="empty">
            <Box size={28} strokeWidth={1.4} aria-hidden />
            <h2>Empty space</h2>
            <p>Add a note to start arranging the project.</p>
            {!realProject && <button onClick={showSample}>Load sample <ArrowRight size={15} /></button>}
          </section>}
          <div className="tools" aria-label="Canvas controls">
            <button aria-label="Select" title="Select" onClick={() => setNodes(current => current.map(node => ({ ...node, selected: false })))}><MousePointer2 size={16} /></button>
            <button aria-label="Snap to grid" title="Snap to grid" aria-pressed={snap} disabled={!settings.canToggle} onClick={() => { void settings.toggleSnap(); }}><Grid2X2 size={15} /></button>
            <button aria-label="Fit all" title="Fit all" onClick={() => { void fitView({ padding: '96px' }); }}><Maximize size={15} /></button>
            <button aria-label="Reset view" title="Reset view" onClick={() => { void setViewport({ x: 0, y: 0, zoom: 1 }); }}><Crosshair size={15} /></button>
            {realProject && <>
              <button disabled={!historyActions.canUndo || pendingWrites > 0} onClick={() => applySpaceChange({ kind: 'undo' })}>Undo</button>
              <button disabled={!historyActions.canRedo || pendingWrites > 0} onClick={() => applySpaceChange({ kind: 'redo' })}>Redo</button>
              <button disabled={!clipboard || pendingWrites > 0} onClick={pasteSelection}>Paste</button>
              <button aria-pressed={linkPanel} onClick={() => { setArchivePending(undefined); setImportReport(undefined); setLinkPanel(value => !value); }}>Links</button>
            </>}
          </div>
          {selected && <aside className={'selection' + (contextOpen ? ' context-open' : '')} aria-label={contextOpen ? 'Object actions' : 'Selection'}>
            {selection.length === 1 && <button ref={openSelectionButton} onClick={event => openCard(selected, event.currentTarget)}>Open {selected.data.title} <ArrowUpRight size={14} /></button>}
            {realProject && <>
              {selection.length > 1 && <span>{selection.length} selected</span>}
              <button disabled={pendingWrites > 0} onClick={() => { void copySelection(); }}>Copy</button>
              {(ungroupable || (selection.length > 1 && selection.every(node => !node.data.groupId))) &&
                <button disabled={pendingWrites > 0} onClick={() => {
                  if (ungroupable) applySpaceChange({ kind: 'ungroup', id: selectedGroup }, true);
                  else applySpaceChange({ kind: 'groupSelection', ids: selection.map(node => node.id) }, true);
                }}>{ungroupable ? 'Ungroup' : 'Group'}</button>}
              <button disabled={pendingWrites > 0} onClick={requestArchive}>Archive</button>
            </>}
          </aside>}
          {linkPanel && <LinkPanel nodes={linkNodes} links={links} busy={pendingWrites > 0}
            onConnect={connectPorts} onRemove={id => applySpaceChange({ kind: 'disconnect', id }, true)} onClose={() => setLinkPanel(false)} />}
          {archivePending && <section className="panel link-panel" aria-label="Confirm archive">
            <h2>Archive selected objects?</h2><p>This removes {archivePending.count} Data Links from Space.</p>
            <div className="file-actions">
              <button onClick={() => setArchivePending(undefined)}>Cancel</button>
              <button className="primary" disabled={pendingWrites > 0} onClick={() => {
                applySpaceChange({ kind: 'archiveSelection', ids: archivePending.ids });
                setArchivePending(undefined);
              }}>Archive objects</button>
            </div>
          </section>}
        </div>
          {importProgress && <section className="panel import-report" aria-label="Import progress">
            <div className="import-report-title">
              <h2>{importProgress.phase === 'committing' ? 'Finishing import' : 'Importing files'}</h2>
              {importProgress.phase === 'copying' && <button disabled={cancelingImport}
                onClick={() => { void cancelImport(); }}>{cancelingImport ? 'Canceling…' : 'Cancel import'}</button>}
            </div>
            {importProgress.phase === 'copying' && <>
              <p>File {importProgress.fileIndex} of {importProgress.totalFiles}</p>
              <progress aria-label="Current file copy" max={importProgress.fileBytes || undefined}
                value={importProgress.fileBytes ? Math.min(importProgress.bytes, importProgress.fileBytes) : undefined} />
              {importProgress.fileBytes > 0 && <p>{new Intl.NumberFormat().format(importProgress.bytes)} of {new Intl.NumberFormat().format(importProgress.fileBytes)} bytes</p>}
            </>}
          </section>}
          {importReport && !importProgress && <section className="panel import-report" aria-label="Import results">
            <div className="import-report-title"><h2>Import results</h2>
              <button aria-label="Dismiss import results" onClick={() => setImportReport(undefined)}><X size={15} /></button></div>
            <ul className="project-list">{importReport.map((item, index) => <li key={item.nodeId ?? index}>
              <strong>{item.name}</strong><span>{item.asset ? 'Imported' : item.message ?? 'Rejected'}</span>
            </li>)}</ul>
          </section>}
        {plainNodes.length > 0 && <div className="plain-workbench">
          {paired && !widePlains && <div className="plain-switch" role="group" aria-label="Shown panel">
            {plainNodes.map(node => <button key={node.id} aria-pressed={visiblePane === node.id} onClick={() => focusPane(node.id)}>
              Show {node.data.title}
            </button>)}
          </div>}
          <div className={'plain-columns' + (paired && widePlains ? ' paired' : '')}>
            {plainNodes.map(node => {
              const visible = !paired || widePlains || visiblePane === node.id;
              return <PlainPane key={node.id} id={node.id} title={node.data.title}
                kind={kindLabel[node.data.kind]} site={Boolean(node.data.site)}
                visible={visible} focus={plainFocus} assetVersion={node.data.asset?.versionId}
                onActivate={setActivePane} onDirty={markPlainDirty}
                close={paired ? () => closePane(node) : undefined}>
                {setPaneDirty => renderPlain(node, setPaneDirty, visible)}
              </PlainPane>;
            })}
          </div>
        </div>}
      </main>
      <footer className="statusbar">
        <span>{nodes.length} objects · {edges.length} links</span>
        {realProject && <span role="status">{saveState}</span>}
        {settings.message && <span role="alert">{settings.message}</span>}
        <div className="zoom">
          <button aria-label="Zoom out" onClick={() => { void zoomOut(); }}><Minus size={14} /></button>
          <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
          <button aria-label="Zoom in" onClick={() => { void zoomIn(); }}><Plus size={14} /></button>
        </div>
      </footer>
    </>}

    {destination !== 'Space' && <main className="secondary">
      <div className="eyebrow">Forge</div><h1>{destination}</h1>
      {destination === 'Projects' && <section className="panel projects">
        <form onSubmit={event => { event.preventDefault(); void chooseProject('create'); }}>
          <label>Project name<input value={requestedTitle} maxLength={240} onChange={event => setRequestedTitle(event.currentTarget.value)} /></label>
          <button className="primary" disabled={working || !requestedTitle.trim()}>Create project</button>
        </form>
        <button disabled={working} onClick={() => { void chooseProject('open'); }}>Open project <ArrowUpRight size={15} /></button>
        {recentMessage && <p role="alert">{recentMessage}</p>}
        {recent.length > 0 && <section className="recent-projects" aria-labelledby="recent-label">
          <h2 id="recent-label">Recent projects</h2>
          <ul className="project-list">{recent.map(item => <li key={item.id}>
            <button disabled={working} onClick={() => { void chooseProject({ recentId: item.id }); }}>{item.title} <ArrowUpRight size={15} /></button>
            <time dateTime={item.openedAt}>{new Date(item.openedAt).toLocaleDateString()}</time>
          </li>)}</ul>
        </section>}
        {realProject && <form onSubmit={event => {
          event.preventDefault();
          commit({ kind: 'renameProject', title: renameTitle }, () => setProjectTitle(renameTitle));
        }}>
          <label>Current project name<input value={renameTitle} maxLength={240} onChange={event => setRenameTitle(event.currentTarget.value)} /></label>
          <button disabled={working || pendingWrites > 0 || !renameTitle.trim() || renameTitle === projectTitle}>Rename project</button>
        </form>}
        {realProject && <button disabled={working || pendingWrites > 0} onClick={() => { void archiveProject(); }}>Archive project</button>}
        {projectMessage && <p role="alert">{projectMessage}</p>}
        {realProject && <p role="status">{saveState}</p>}
        <button onClick={() => navigate('Space')}>Return to workspace <ArrowRight size={15} /></button>
      </section>}
      {destination === 'Settings' && <>
        <BackupSettings disabled={pendingWrites > 0 || working || settings.busy}
          project={realProject ? { projectId: projectId.current, baseRevision: revision.current } : undefined}
          onSettingsRestored={settings.adopt} />
        {settings.message && <p role="alert">{settings.message} <button disabled={settings.busy} onClick={() => { void settings.refresh(); }}>Reload settings</button></p>}
        <UpdateSettings version={appVersion} busy={pendingWrites > 0 || working || settings.busy} hasProject={realProject} />
      </>}
      {destination === 'Logs' && <>
        <DiagnosticsLogs health={diagnosticHealth} busy={pendingWrites > 0 || working} />
        {realProject && <><ProjectHistory key={projectId.current} revision={revision.current} busy={pendingWrites > 0} onRestore={restoreRevision} />
          <p role="status">{saveState}</p></>}
      </>}
      {destination === 'Documentation' && <section className="panel">
        <h2>Space navigation</h2>
        <p>Use the wheel to zoom. Hold Space or drag with the middle mouse button to pan. Select a card and use Open to enter it. Use the arrow keys from a selected card or its actions to move the selection.</p>
        <p>Use Open beside to work in a second Plain. On a narrow window, the Show buttons keep your other Plain open with its selection and draft. Close either panel or use Back to Space to return to the canvas.</p>
        <p>Choose Import files or drop files from the filesystem onto an open Space. Forge keeps the original and reports the result of each file.</p>
        <p>In Gallery, choose Import media to add images and videos. WebM and MP4 tiles show a poster and open a local player. Palette uses the still images and reports skipped videos.</p>
        <h3>Site references</h3>
        <p>Open a Site card and enter an HTTPS address. Choose Capture current page to review a link and add a manual quote before saving it to the project. Use Clear site data to remove the session for that card.</p>
        <h3>Research sources and citations</h3>
        <p>Link a text file, saved Site quote or image to a Research card in Space. Choose Capture source to save its current version. Select text in a saved version and choose Save selected text as citation. Use Search saved sources to find a version by title or text. The indexed count updates as versions are saved.</p>
        <p>Capture latest version keeps existing citations available and marks conclusions based on an earlier context. If a link is removed, the saved material stays readable. Project ZIPs include saved sources, citations and conclusions.</p>
        <p>For a linked PDF, Capture source reads its text layer locally. Use Enter PDF text when a scan or a file outside the extraction limits needs a manual excerpt. Forge keeps that text with the selected PDF version.</p>
        <p>For a linked PCM WAV recording, Capture source saves playable audio. Add transcript records literal text and ordered start and end times. Select a saved time range to seek in the recording.</p>
        <p>With a local whisper.cpp server on port 8080, use Transcribe automatically to review an eligible WAV up to 16 MiB. Choose the language and approve sending that recording. Review the result and choose Save automatic transcript to keep a new version.</p>
        <h3>Intelligent context review</h3>
        <p>Connect sources to Intelligent, select exact materials and choose Review context. The review shows the provider, model, source revisions and the text that will be sent. Approve Site quotes separately. Save result to project keeps the answer and its provenance in project backups.</p>
        <h3>Compare files and images</h3>
        <p>Connect two items to Comparison and choose Calculate. Compare lines from notes, TXT, Markdown, DOCX or PDF with a text layer. PNG, JPEG and WebP show side-by-side previews. Matching images up to four million pixels can also show a pixel difference.</p>
        <h3>Edit images</h3>
        <p>Connect an image or Gallery to Editor in Links and select the input version. Add and order processing nodes, then choose Render preview to check the result. Save recipe and confirm Export image to create a new PNG or JPEG in Space. Repeat export uses the recorded recipe and input version.</p>
        <p>In Git, choose the root folder of a local repository. Review staged and unstaged diffs, select changes to stage, then enter the author and message for a local commit. Switch branches from a clean working tree. Open remote hosting in Site.</p>
        <h3>Stable updates</h3>
        <p>Open Forge from its installed launcher. In Settings, check for updates and review the signed release notes. Choose Install and save a new backup ZIP. Forge verifies the download, restarts and shows the installed version and startup result in Updates.</p>
        <p>After a completed update, choose Roll back to when the previous version is available. Select the original update ZIP to restore its application settings and restart.</p>
        <button onClick={() => navigate('Space')}><X size={15} /> Close</button>
      </section>}
    </main>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<ReactFlowProvider><Workspace /></ReactFlowProvider>);

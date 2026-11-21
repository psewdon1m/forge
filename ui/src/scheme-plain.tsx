import { useEffect, useState } from 'react';
import {
  Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import type {
  ProjectViewport, SchemeConnection, SchemeDocument, SchemeElement, SchemeGraph, SchemeKind,
} from './project-api';

const historyLimit = 40;
const elementLabels: Record<SchemeKind, string> = {
  rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', text: 'Text', line: 'Line',
};
type ShapeNode = Node<{ element: SchemeElement }, 'schemeShape'>;
type HistoryEntry = { graph: SchemeGraph; viewport?: ProjectViewport };
type History = { present: SchemeGraph; past: HistoryEntry[]; future: HistoryEntry[] };
type Props = {
  document: SchemeDocument; projectId: string; nodeId: string; baseRevision: number; busy: boolean;
  onSave: (scheme: SchemeDocument, finished: () => void) => void; onDirty: (value: boolean) => void;
};

function Shape({ data, selected }: NodeProps<ShapeNode>) {
  const { kind, angle, text } = data.element;
  const geometry = kind === 'rectangle' ? <rect x="1" y="1" width="98" height="98" />
    : kind === 'ellipse' ? <ellipse cx="50" cy="50" rx="49" ry="49" />
    : kind === 'diamond' ? <polygon points="50,1 99,50 50,99 1,50" />
    : kind === 'line' ? <line x1="1" x2="99" y1="50" y2="50" /> : null;
  return <div className={'scheme-shape' + (selected ? ' scheme-selected' : '')} data-kind={kind}>
    {geometry && <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none"
      style={kind === 'line' ? { transform: 'rotate(' + (angle ?? 0) + 'deg)' } : undefined}>{geometry}</svg>}
    {kind !== 'line' && <Handle type="target" position={Position.Left} />}
    <span>{text}</span>
    {kind !== 'line' && <Handle type="source" position={Position.Right} />}
  </div>;
}

const nodeTypes = { schemeShape: Shape };
const origin: ProjectViewport = { x: 0, y: 0, zoom: 1 };

function shapeNode(element: SchemeElement, selected: boolean): ShapeNode {
  return {
    id: element.id, type: 'schemeShape', position: element.position, selected,
    style: { width: element.width, height: element.height },
    ariaLabel: elementLabels[element.kind] + (element.text ? ' ' + element.text : ''),
    data: { element },
  };
}

function connectionEdge(line: SchemeConnection, selected: boolean): Edge {
  return {
    id: line.id, source: line.from, target: line.to, type: line.route === 'straight' ? 'straight' : 'step',
    label: line.text, selected, ariaLabel: line.text || 'Connection',
    labelShowBg: true, labelBgPadding: [4, 2], labelBgBorderRadius: 0,
  };
}

function sameViewport(left: ProjectViewport, right: ProjectViewport) {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function Editor({ document, projectId, nodeId, baseRevision, busy, onSave, onDirty }: Props) {
  const [saved, setSaved] = useState(document);
  const [history, setHistory] = useState<History>({ present: document, past: [], future: [] });
  const [viewport, setViewport] = useState(document.viewport);
  const [nodes, setNodes, changeNodes] = useNodesState<ShapeNode>(document.elements.map(item => shapeNode(item, false)));
  const [edges, setEdges, changeEdges] = useEdgesState(document.lines.map(item => connectionEdge(item, false)));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error?: true }>();
  const { fitView, zoomIn, zoomOut } = useReactFlow<ShapeNode, Edge>();
  const graph = history.present;
  const current = { elements: graph.elements, lines: graph.lines, viewport };
  const dirty = graph.elements !== saved.elements || graph.lines !== saved.lines || !sameViewport(viewport, saved.viewport);
  const selectedElements = nodes.filter(node => node.selected).map(node => node.id);
  const selectedLines = edges.filter(edge => edge.selected).map(edge => edge.id);
  const selected = selectedElements.length === 1 ? graph.elements.find(item => item.id === selectedElements[0]) : undefined;
  const selectedLine = !selected && selectedLines.length === 1 ? graph.lines.find(item => item.id === selectedLines[0]) : undefined;
  const endpoints = graph.elements.filter(item => item.kind !== 'line');
  const locked = busy || fileBusy;

  useEffect(() => {
    setNodes(old => {
      const selected = new Set(old.filter(node => node.selected).map(node => node.id));
      return graph.elements.map(item => shapeNode(item, selected.has(item.id)));
    });
    setEdges(old => {
      const selected = new Set(old.filter(edge => edge.selected).map(edge => edge.id));
      return graph.lines.map(item => connectionEdge(item, selected.has(item.id)));
    });
  }, [graph, setEdges, setNodes]);

  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  function edit(update: (previous: SchemeGraph) => SchemeGraph, nextViewport?: ProjectViewport) {
    if (locked) return;
    setHistory(state => {
      const present = update(state.present);
      if (present === state.present) return state;
      const previous = { graph: state.present, viewport: nextViewport ? viewport : undefined };
      return { present, past: [...state.past.slice(-(historyLimit - 1)), previous], future: [] };
    });
    if (nextViewport) setViewport(nextViewport);
  }

  function undo() {
    const previous = history.past.at(-1);
    if (locked || !previous) return;
    setHistory({
      present: previous.graph, past: history.past.slice(0, -1),
      future: [{ graph, viewport: previous.viewport ? viewport : undefined }, ...history.future],
    });
    if (previous.viewport) setViewport(previous.viewport);
  }

  function redo() {
    const next = history.future[0];
    if (locked || !next) return;
    setHistory({
      present: next.graph, past: [...history.past, { graph, viewport: next.viewport ? viewport : undefined }],
      future: history.future.slice(1),
    });
    if (next.viewport) setViewport(next.viewport);
  }

  function add(kind: SchemeKind) {
    const column = graph.elements.length % 2;
    const row = Math.floor(graph.elements.length / 2) % 3;
    const offset = (Math.floor(graph.elements.length / 6) % 4) * 15;
    const element: SchemeElement = {
      id: crypto.randomUUID(), kind, position: {
        x: (45 + column * 224 + offset - viewport.x) / viewport.zoom,
        y: (42 + row * 112 + offset - viewport.y) / viewport.zoom,
      },
      width: 146, height: kind === 'text' || kind === 'line' ? 48 : 76,
      text: kind === 'line' ? '' : elementLabels[kind],
    };
    if (locked || graph.elements.length >= 500) return;
    if (Math.abs(element.position.x) > 1_000_000 || Math.abs(element.position.y) > 1_000_000) {
      setNotice({ error: true, message: 'Reset the view before placing another element.' });
      return;
    }
    edit(state => ({ ...state, elements: [...state.elements, element] }));
    setNodes(old => [...old.map(node => ({ ...node, selected: false })), shapeNode(element, true)]);
    setEdges(old => old.map(edge => ({ ...edge, selected: false })));
  }

  function connect(first: string, last: string) {
    if (locked || first === last || !endpoints.some(item => item.id === first) || !endpoints.some(item => item.id === last)) return;
    if (graph.lines.length >= 1000 || graph.lines.some(line =>
      (line.from === first && line.to === last) || (line.from === last && line.to === first))) return;
    const line: SchemeConnection = { id: crypto.randomUUID(), from: first, to: last, route: 'straight', text: '' };
    edit(state => ({ ...state, lines: [...state.lines, line] }));
    setFrom(''); setTo('');
  }

  function updateNodes(changes: NodeChange<ShapeNode>[]) {
    changeNodes(changes);
    const positions = new Map(changes.flatMap(change =>
      change.type === 'position' && change.dragging !== true && change.position ? [[change.id, change.position] as const] : []));
    if (!positions.size) return;
    edit(state => {
      let moved = false;
      const elements = state.elements.map(item => {
        const position = positions.get(item.id);
        if (!position || (position.x === item.position.x && position.y === item.position.y)) return item;
        moved = true;
        return { ...item, position };
      });
      return moved ? { ...state, elements } : state;
    });
  }

  function removeSelection() {
    if (!selectedElements.length && !selectedLines.length) return;
    edit(state => ({
      elements: state.elements.filter(item => !selectedElements.includes(item.id)),
      lines: state.lines.filter(line => !selectedLines.includes(line.id) &&
        !selectedElements.includes(line.from) && !selectedElements.includes(line.to)),
    }));
  }

  function updateText(text: string) {
    if (new TextEncoder().encode(text).length > 4096) {
      setNotice({ error: true, message: 'A Scheme label can contain up to 4,096 UTF-8 bytes.' });
      return;
    }
    setNotice(undefined);
    if (selected) edit(state => ({ ...state, elements: state.elements.map(item => item.id === selected.id ? { ...item, text } : item) }));
    if (selectedLine) edit(state => ({ ...state, lines: state.lines.map(item => item.id === selectedLine.id ? { ...item, text } : item) }));
  }

  async function openFile() {
    const api = window.forge?.project;
    if (!api || locked || dirty) return;
    setFileBusy(true);
    setNotice(undefined);
    try {
      const reply = await api.schemeRead({ projectId });
      if (!reply.ok) setNotice({ error: true, message: reply.error.message });
      else if (reply.value) {
        const imported = reply.value.document;
        edit(() => imported, imported.viewport);
        setNotice({ message: 'Loaded ' + reply.value.name + ' into the Scheme draft.' });
      }
    } catch { setNotice({ error: true, message: 'Could not open the Scheme JSON.' }); }
    finally { setFileBusy(false); }
  }

  async function exportFile() {
    const api = window.forge?.project;
    if (!api || locked || dirty) return;
    setFileBusy(true);
    setNotice(undefined);
    try {
      const reply = await api.schemeExport({ projectId, nodeId, baseRevision });
      if (!reply.ok) setNotice({ error: true, message: reply.error.message });
      else if (reply.value) setNotice({ message: 'Scheme JSON saved.' });
    } catch { setNotice({ error: true, message: 'Could not export the Scheme JSON.' }); }
    finally { setFileBusy(false); }
  }

  return <section className="scheme-panel" aria-label="Scheme editor">
    <div className="file-actions scheme-toolbar" aria-label="Scheme editing commands">
      {Object.entries(elementLabels).map(([kind, label]) => <button key={kind} disabled={locked || graph.elements.length >= 500}
        onClick={() => add(kind as SchemeKind)}>Add {label.toLowerCase()}</button>)}
      <button disabled={locked || !history.past.length} onClick={undo}>Undo edit</button>
      <button disabled={locked || !history.future.length} onClick={redo}>Redo edit</button>
      <button disabled={locked || !selectedElements.length && !selectedLines.length} onClick={removeSelection}>Remove selection</button>
      <button className="primary" disabled={locked || !dirty} onClick={() => {
        setNotice(undefined);
        onSave(current, () => {
          setSaved(current);
          setNotice({ message: 'Scheme saved.' });
        });
      }}>Save scheme</button>
      {dirty && <button disabled={locked} onClick={() => {
        setHistory({ present: saved, past: [], future: [] });
        setViewport(saved.viewport); setNotice(undefined);
      }}>Discard scheme draft</button>}
    </div>
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.message}</p>}
    <div className="scheme-workbench">
      <div className="scheme-stage" aria-label="Scheme canvas" tabIndex={0} onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || event.target.closest('input,textarea,select,button')) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) redo(); else undo();
        } else if (event.key === 'Delete') {
          event.preventDefault(); removeSelection();
        }
      }}>
        <ReactFlow<ShapeNode>
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={updateNodes} onEdgesChange={changeEdges}
          viewport={viewport} onViewportChange={locked ? undefined : setViewport}
          deleteKeyCode={null} minZoom={0.05} maxZoom={8} panOnDrag={[1, 2]}
          nodesDraggable={!locked} nodesConnectable={!locked}
          onConnect={pair => { if (pair.source && pair.target) connect(pair.source, pair.target); }}
        ><Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#d6d6d1" /></ReactFlow>
      </div>
      <aside className="scheme-inspector" aria-label="Scheme properties">
        <div className="file-actions">
          <button onClick={() => { void zoomIn(); }} disabled={locked}>Zoom in</button>
          <button onClick={() => { void zoomOut(); }} disabled={locked}>Zoom out</button>
          <button onClick={() => { void fitView({ padding: 0.2 }); }} disabled={locked || !nodes.length}>Fit scheme</button>
          <button onClick={() => setViewport(origin)} disabled={locked}>Reset view</button>
        </div>
        <p className="scheme-scale"><output aria-label="Scheme zoom">{Math.round(viewport.zoom * 100)}%</output></p>
        {endpoints.length > 1 && <form onSubmit={event => { event.preventDefault(); connect(from, to); }}>
          <label>From element<select value={from} onChange={event => setFrom(event.target.value)} disabled={locked}>
            <option value="">Choose an element</option>
            {endpoints.map(item => <option value={item.id} key={item.id}>{item.text || elementLabels[item.kind]}</option>)}
          </select></label>
          <label>To element<select value={to} onChange={event => setTo(event.target.value)} disabled={locked}>
            <option value="">Choose an element</option>
            {endpoints.map(item => <option value={item.id} key={item.id}>{item.text || elementLabels[item.kind]}</option>)}
          </select></label>
          <button disabled={locked || !from || !to || from === to}>Connect elements</button>
        </form>}
        {(selected || selectedLine) && <label>{selected ? 'Element text' : 'Connection text'}
          <textarea value={selected?.text ?? selectedLine?.text ?? ''} disabled={locked} onChange={event => updateText(event.target.value)} />
        </label>}
        {selected?.kind === 'line' && <label>Line angle <input type="range" min="0" max="359" value={selected.angle ?? 0}
          disabled={locked} onChange={event => {
            const angle = Number(event.target.value);
            edit(state => ({ ...state, elements: state.elements.map(item => item.id === selected.id ? { ...item, angle } : item) }));
          }} /></label>}
        {selectedLine && <label>Connection route <select value={selectedLine.route} disabled={locked} onChange={event => {
          const route = event.target.value as SchemeConnection['route'];
          edit(state => ({ ...state, lines: state.lines.map(item => item.id === selectedLine.id ? { ...item, route } : item) }));
        }}><option value="straight">Straight</option><option value="orthogonal">Orthogonal</option></select></label>}
        <div className="file-actions scheme-files">
          <button disabled={locked || dirty} onClick={() => { void openFile(); }}>Open Scheme JSON</button>
          <button disabled={locked || dirty} onClick={() => { void exportFile(); }}>Export Scheme JSON</button>
        </div>
      </aside>
    </div>
  </section>;
}

export default function SchemePlain(props: Props) {
  return <ReactFlowProvider><Editor {...props} /></ReactFlowProvider>;
}

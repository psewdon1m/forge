import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'scheme-ui-'));
const directory = path.join(run, 'Project');
const exported = path.join(run, 'lighting.forge-scheme.json');
const incompatible = path.join(run, 'future.forge-scheme.json');
const archive = path.join(run, 'lighting.zip');
const screenshot = path.join(run, 'scheme.png');
await mkdir(directory);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, 'Profile') },
  });
  await choose(app, directory);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  (await app.firstWindow()).setDefaultTimeout(8_000);
  return app;
}

async function choose(app, filePath) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, filePath);
}

const button = (area, name) => area.getByRole('button', { name, exact: true });
const scheme = page => page.getByRole('region', { name: 'Scheme editor' });
const invoke = (page, name, data) => page.evaluate(([name, data]) => window.forge.project[name](data), [name, data]);
function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const view = page => invoke(page, 'view').then(value);
const readScheme = (space, nodeId) => JSON.parse(space.nodes.find(node => node.id === nodeId).content.payload);

async function save(panel) {
  await button(panel, 'Save scheme').click();
  await expect(panel.getByText('Scheme saved.', { exact: true })).toBeVisible();
  await expect(button(panel, 'Save scheme')).toBeDisabled();
}

async function apply(page, change) {
  const { space, revision } = await view(page);
  return value(await invoke(page, 'apply', {
    projectId: space.projectId, baseRevision: revision, operationId: randomUUID(), change,
  }));
}

async function capture(app, page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw new Error('Scheme capture is empty');
    return image.toPNG().toString('base64');
  });
  await writeFile(screenshot, Buffer.from(png, 'base64'));
}

let app = await launch();
let query;
let exportedScheme;
let graph;
let resultDigest;
try {
  const page = await app.firstWindow();
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Lighting plan');
  await button(page, 'Create project').click();
  await button(page, 'Add Scheme').click();
  await button(page, 'Open Scheme').click();
  const panel = scheme(page);
  const stage = panel.locator('.scheme-stage');
  const shapes = stage.locator('.react-flow__node');
  const lines = stage.locator('.react-flow__edge');
  const { space: { projectId, nodes: [{ id: nodeId }] } } = await view(page);
  query = { projectId, nodeId };

  for (const [kind, label] of [
    ['rectangle', 'Main camera'], ['ellipse', 'Lighting'],
    ['diamond', 'Review'], ['text', 'План съёмки'], ['line', 'Divider'],
  ]) {
    await button(panel, 'Add ' + kind).click();
    await panel.getByLabel('Element text').fill(label);
  }
  await expect(shapes).toHaveCount(5);
  await panel.getByLabel('Line angle').press('ArrowRight');
  await expect(panel.getByLabel('Line angle')).toHaveValue('1');
  for (const [from, to] of [['Main camera', 'Lighting'], ['Lighting', 'Review']]) {
    await panel.getByLabel('From element').selectOption({ label: from });
    await panel.getByLabel('To element').selectOption({ label: to });
    await button(panel, 'Connect elements').click();
  }
  await expect(lines).toHaveCount(2);
  await button(panel, 'Undo edit').click();
  await expect(lines).toHaveCount(1);
  await button(panel, 'Redo edit').click();
  await expect(lines).toHaveCount(2);
  const edgePoint = await lines.first().locator('.react-flow__edge-interaction').evaluate(edge => {
    const local = edge.getPointAtLength(edge.getTotalLength() / 2);
    const client = local.matrixTransform(edge.getScreenCTM());
    return { x: client.x, y: client.y };
  });
  await page.mouse.click(edgePoint.x, edgePoint.y);
  await panel.getByLabel('Connection route').selectOption('orthogonal');
  await panel.getByLabel('Connection text').fill('Key light');

  const camera = shapes.filter({ hasText: 'Main camera' });
  const pickup = { x: 60, y: 18 };
  await camera.hover({ position: pickup });
  const shapeBox = await camera.boundingBox();
  assert.ok(shapeBox, 'The camera must be visible before dragging');
  const start = { x: shapeBox.x + pickup.x, y: shapeBox.y + pickup.y };
  await page.mouse.down();
  try {
    // React Flow begins the drag after the movement threshold is crossed.
    await page.mouse.move(start.x + 3, start.y + 3);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await page.mouse.move(start.x + 22, start.y + 25);
  } finally {
    await page.mouse.up();
  }
  await expect(button(panel, 'Open Scheme JSON')).toBeDisabled();
  await expect(button(panel, 'Export Scheme JSON')).toBeDisabled();
  await button(page, 'Back to Space').click();
  await expect(page.getByText('Save or discard the file changes before leaving.')).toBeVisible();
  await save(panel);
  const preCamera = readScheme((await view(page)).space, nodeId);
  assert.ok(Math.abs(preCamera.elements[0].position.x - 64) <= 4);
  assert.ok(Math.abs(preCamera.elements[0].position.y - 64) <= 4);
  assert.deepEqual(preCamera.viewport, { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(preCamera.lines.map(line => [line.route, line.text]), [['orthogonal', 'Key light'], ['straight', '']]);
  const preCameraGraph = value(await invoke(page, 'schemeGraph', query));

  const pane = stage.locator('.react-flow__pane');
  const initialPaneBox = await pane.boundingBox();
  assert.ok(initialPaneBox, 'The Scheme canvas must be visible before panning');
  const panOrigin = { x: initialPaneBox.width - 110, y: 65 };
  await pane.hover({ position: panOrigin });
  const paneBox = await pane.boundingBox();
  assert.ok(paneBox);
  const panStart = { x: paneBox.x + panOrigin.x, y: paneBox.y + panOrigin.y };
  await page.mouse.down({ button: 'middle' });
  try {
    await page.mouse.move(panStart.x + 23, panStart.y + 20);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  } finally {
    await page.mouse.up({ button: 'middle' });
  }
  await expect(button(panel, 'Save scheme')).toBeEnabled();
  await save(panel);
  const afterPan = readScheme((await view(page)).space, nodeId).viewport;
  assert.ok(afterPan.x > 10 && afterPan.x < 35, JSON.stringify(afterPan));
  assert.ok(afterPan.y > 0 && afterPan.y < 60, JSON.stringify(afterPan));
  assert.equal(afterPan.zoom, 1);
  await button(panel, 'Zoom in').click();
  await expect(panel.getByLabel('Scheme zoom')).toHaveText('120%');
  await save(panel);
  graph = value(await invoke(page, 'schemeGraph', { ...query, sourceRevision: preCameraGraph.sourceRevision }));
  assert.deepEqual(graph, preCameraGraph);

  await button(panel, 'Export Scheme JSON').click();
  await expect(panel.getByText('Scheme JSON saved.', { exact: true })).toBeVisible();
  const original = await readFile(exported);
  exportedScheme = JSON.parse(original);
  assert.deepEqual(exportedScheme, {
    format: 'forge-scheme', schemaVersion: 1, document: readScheme((await view(page)).space, nodeId),
  });
  await button(panel, 'Export Scheme JSON').click();
  await expect(panel.getByRole('alert')).toBeVisible();
  assert.deepEqual(await readFile(exported), original);
  await writeFile(incompatible, JSON.stringify({ ...exportedScheme, schemaVersion: 2 }));
} finally {
  await app.close();
}

app = await launch();
try {
  const page = await app.firstWindow();
  await button(page, 'Projects').click();
  await button(page, 'Lighting plan').click();
  await button(page, 'Fit all').click();
  await page.locator('.react-flow__node[data-id="' + query.nodeId + '"]').dblclick();
  const panel = scheme(page);
  const shapes = panel.locator('.react-flow__node');
  await expect(shapes).toHaveCount(5);
  await expect(panel.getByLabel('Scheme zoom')).toHaveText('120%');
  assert.deepEqual(readScheme((await view(page)).space, query.nodeId), exportedScheme.document);
  assert.deepEqual(value(await invoke(page, 'schemeGraph', query)), graph);
  await button(panel, 'Fit scheme').click();
  await expect(button(panel, 'Discard scheme draft')).toBeVisible();
  await capture(app, page);
  await button(panel, 'Discard scheme draft').click();
  await expect(panel.getByLabel('Scheme zoom')).toHaveText('120%');

  await button(page, 'Back to Space').click();
  await button(page, 'Add Scheme').click();
  await button(page, 'Open Scheme').click();
  const { space, revision } = await view(page);
  const importedId = space.nodes.find(node => node.id !== query.nodeId).id;
  await choose(app, incompatible);
  await button(panel, 'Open Scheme JSON').click();
  await expect(panel.getByRole('alert')).toContainText(/schema/i);
  assert.equal((await view(page)).revision, revision);
  await choose(app, exported);
  await button(panel, 'Open Scheme JSON').click();
  await expect(panel.getByText('Loaded lighting.forge-scheme.json into the Scheme draft.')).toBeVisible();
  await expect(shapes).toHaveCount(5);
  await button(panel, 'Undo edit').click();
  await expect(shapes).toHaveCount(0);
  await expect(panel.getByLabel('Scheme zoom')).toHaveText('100%');
  await button(panel, 'Redo edit').click();
  await expect(shapes).toHaveCount(5);
  await expect(panel.getByLabel('Scheme zoom')).toHaveText('120%');
  await save(panel);
  assert.deepEqual(readScheme((await view(page)).space, importedId), exportedScheme.document);
  assert.deepEqual(value(await invoke(page, 'schemeGraph', { ...query, nodeId: importedId })), graph);
  await shapes.filter({ hasText: 'Main camera' }).click();
  await panel.getByLabel('Element text').fill('Alternate camera');
  await save(panel);
  const stale = await invoke(page, 'schemeGraph', { ...query, nodeId: importedId, sourceRevision: graph.sourceRevision });
  assert.equal(stale.error.code, 'SOURCE_CHANGED');

  const targetId = randomUUID();
  await apply(page, { kind: 'add', node: {
    id: targetId, label: 'Compare schemes', position: { x: 500, y: 40 },
    content: { kind: 'portal', plainId: randomUUID(), typeId: 'forge.comparison', schemaVersion: 1, payload: '{}' },
  } });
  const target = { projectId: query.projectId, targetId };
  const sources = [];
  for (const nodeId of [query.nodeId, importedId]) {
    const linkId = randomUUID();
    await apply(page, { kind: 'connect', id: linkId, source: { nodeId, portId: 'text' }, target: { nodeId: targetId, portId: 'sources' } });
    const linked = value(await invoke(page, 'linkedText', { ...target, linkId }));
    assert.match(linked.text, /План съёмки\nDivider\nKey light$/);
    sources.push({ linkId, sourceRevision: linked.sourceRevision, versionId: null });
  }
  const result = value(await invoke(page, 'runComparison', {
    ...target, operationId: randomUUID(), baseRevision: (await view(page)).revision,
    left: sources[0], right: sources[1],
  }));
  assert.equal(result.mode, 'text');
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  resultDigest = result.resultDigest;

  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, archive);
  const original = await view(page);
  value(await invoke(page, 'exportBackup', { projectId: query.projectId, baseRevision: original.revision }));
  await choose(app, archive);
  const { token } = value(await invoke(page, 'inspectBackup'));
  await choose(app, run);
  const { projectId } = value(await invoke(page, 'restoreBackup', token));
  assert.notEqual(projectId, query.projectId);
  const restored = value(await invoke(page, 'openRecent', projectId));
  for (const nodeId of [query.nodeId, importedId]) {
    assert.deepEqual(readScheme(restored.space, nodeId), readScheme(original.space, nodeId));
  }
  assert.deepEqual(restored.space.links, original.space.links);
} finally {
  await app.close();
}

console.log(JSON.stringify({
  outcome: 'PASS', run, screenshot, elements: graph.elements.length, connections: graph.lines.length,
  viewport: exportedScheme.document.viewport, documentSha256: createHash('sha256').update(await readFile(exported)).digest('hex'),
  graphRevision: graph.sourceRevision, resultDigest, declinedFutureSchema: true,
  dragPersisted: true, undoRedo: true, importUndoRedo: true, restartPreserved: true, staleGraphRejected: true,
  exportRoundTrip: true, occupiedExportPreserved: true, cameraOnlyKeepsGraphRevision: true,
  projectBackupPreservedSchemesAndLinks: true,
  coreSha256: createHash('sha256').update(await readFile(path.join(root, '.local/bin/forge-core.exe'))).digest('hex'),
}, null, 2));

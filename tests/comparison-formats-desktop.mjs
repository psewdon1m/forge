import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';
import { onePagePdf, oneParagraphDocx } from './document-fixtures.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'comparison-formats-'));
const project = path.join(run, 'Project');
const archive = path.join(run, 'comparison.zip');
await mkdir(project);
const fixtureNames = ['Source.docx', 'Source.pdf', 'Empty.pdf', 'Unchanged.png', 'Edited.png'];
const files = fixtureNames.map(name => path.join(run, name));

async function launch(profile) {
  const app = await _electron.launch({ executablePath, args: [root], timeout: 20_000, env: {
    ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile),
  } });
  await app.evaluate(({ dialog }, archive) => {
    globalThis.comparisonFiles = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.comparisonFiles });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: archive });
  }, archive);
  return app;
}

const choose = (app, files) => app.evaluate((_, files) => { globalThis.comparisonFiles = files; }, files);
const button = (area, name) => area.getByRole('button', { name, exact: true });
const api = (page, method, request) => page.evaluate(([method, request]) => window.forge.project[method](request), [method, request]);
function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const view = page => api(page, 'view').then(value);
async function edit(page, change) {
  const snapshot = await view(page);
  return value(await api(page, 'apply', { projectId: snapshot.space.projectId,
    operationId: randomUUID(), baseRevision: snapshot.revision, change }));
}
async function connect(page, source, target) {
  const id = randomUUID();
  await edit(page, { kind: 'connect', id, source: { nodeId: source, portId: 'files' },
    target: { nodeId: target, portId: 'sources' } });
  return id;
}
async function openComparison(page, id) {
  await button(page, 'Fit all').click();
  await page.locator(`.react-flow__node[data-id="${id}"]`).dblclick();
  const panel = page.getByRole('region', { name: 'Comparison analysis' });
  await expect(panel).toBeVisible();
  return panel;
}
async function select(panel, left, right) {
  await panel.getByLabel('Left source').selectOption(left.link);
  await panel.getByLabel('Left item').selectOption({ label: left.name });
  await panel.getByLabel('Right source').selectOption(right.link);
  await panel.getByLabel('Right item').selectOption({ label: right.name });
}
async function openProject(app, page, folder) {
  await choose(app, [folder]);
  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  await expect(page.getByRole('heading', { name: 'Formats qualification' })).toBeVisible();
}

let app;
try {
  app = await launch('First profile');
  let page = await app.firstWindow();
  const [before, after] = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 4;
    const context = canvas.getContext('2d');
    context.fillStyle = '#924a31';
    context.fillRect(0, 0, 8, 4);
    const before = canvas.toDataURL().split(',')[1];
    context.fillStyle = '#124e90';
    context.fillRect(0, 0, 2, 4);
    return [before, canvas.toDataURL().split(',')[1]];
  });
  await Promise.all([
    writeFile(files[0], oneParagraphDocx('Field &amp; lens before')),
    writeFile(files[1], onePagePdf('Field & lens after')),
    writeFile(files[2], onePagePdf('')),
    writeFile(files[3], Buffer.from(before, 'base64')),
    writeFile(files[4], Buffer.from(after, 'base64')),
  ]);
  await choose(app, [project]);
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Formats qualification');
  await button(page, 'Create project').click();
  await choose(app, files);
  await button(page, 'Import files').click();
  await expect(page.getByText('Imported 5 of 5 files')).toBeVisible();
  await button(page, 'Dismiss import results').click();
  const initial = await view(page);
  const names = new Map(initial.space.nodes.map(node => [node.label, node]));
  const documentTarget = randomUUID();
  const pixelTarget = randomUUID();
  for (const [id, label, x] of [[documentTarget, 'Document changes', 800], [pixelTarget, 'Image changes', 1150]]) {
    await edit(page, { kind: 'add', node: { id, label, position: { x, y: 200 },
      content: { kind: 'portal', plainId: randomUUID(), typeId: 'forge.comparison', schemaVersion: 1, payload: '{}' } } });
  }
  const documentLinks = [await connect(page, names.get(fixtureNames[0]).id, documentTarget),
    await connect(page, names.get(fixtureNames[1]).id, documentTarget)];
  const pixelLinks = [await connect(page, names.get(fixtureNames[3]).id, pixelTarget),
    await connect(page, names.get(fixtureNames[4]).id, pixelTarget)];
  const projectId = initial.space.projectId;
  const snapshot = targetId => api(page, 'comparisonStatus', { projectId, targetId }).then(value);
  await openProject(app, page, project);
  const documentPanel = await openComparison(page, documentTarget);
  await select(documentPanel, { link: documentLinks[0], name: fixtureNames[0] }, { link: documentLinks[1], name: fixtureNames[1] });
  await button(documentPanel, 'Calculate').click();
  const diff = documentPanel.getByRole('region', { name: 'Text comparison' });
  await expect(diff.getByText('Field & lens before', { exact: true })).toBeVisible();
  await expect(diff.getByText('Field & lens after', { exact: true })).toBeVisible();
  const text = (await snapshot(documentTarget)).latest;
  assert.equal(text.algorithm, 'forge.comparison.documents-and-pixels.v2');
  assert.deepEqual(text.pair.map(item => item.choice.asset.sha256), fixtureNames.slice(0, 2).map(name => names.get(name).content.asset.sha256));
  await button(page, 'Back to Space').click();
  await edit(page, { kind: 'disconnect', id: documentLinks[1] });
  const empty = await connect(page, names.get(fixtureNames[2]).id, documentTarget);
  await openProject(app, page, project);
  await openComparison(page, documentTarget);
  await select(documentPanel, { link: documentLinks[0], name: fixtureNames[0] }, { link: empty, name: fixtureNames[2] });
  await documentPanel.getByRole('button', { name: /^(Recalculate|Calculate)$/ }).click();
  await expect(documentPanel.getByText(/PDF has no extractable text/)).toBeVisible();
  assert.deepEqual((await snapshot(documentTarget)).latest, text);
  await button(page, 'Back to Space').click();

  const imagePanel = await openComparison(page, pixelTarget);
  await select(imagePanel, { link: pixelLinks[0], name: fixtureNames[3] }, { link: pixelLinks[1], name: fixtureNames[4] });
  await button(imagePanel, 'Calculate').click();
  const difference = imagePanel.getByRole('region', { name: 'Pixel difference' });
  const mask = difference.getByRole('img', { name: 'Difference mask' });
  await expect(difference.getByText('8 of 32 pixels differ · 8 × 4')).toBeVisible();
  await expect(mask).toBeVisible();
  const maskPixels = await mask.evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from({ length: canvas.width * canvas.height }, (_, index) => data[index * 4]);
  });
  assert.deepEqual(maskPixels, Array.from({ length: 32 }, (_, index) => index % 8 < 2 ? 0 : 255));
  const pixel = (await snapshot(pixelTarget)).latest;
  assert.deepEqual(pixel.pixelComparison, { state: 'compared', width: 8, height: 4, changedPixels: 8 });
  await button(page, 'Back to Space').click();
  value(await api(page, 'exportBackup', { projectId, baseRevision: (await view(page)).revision }));
  await app.close();

  app = await launch('Restored profile');
  page = await app.firstWindow();
  await choose(app, [archive]);
  const inspection = value(await api(page, 'inspectBackup'));
  await choose(app, [run]);
  const restored = value(await api(page, 'restoreBackup', inspection.token));
  await openProject(app, page, path.join(run, restored.folder));
  const newId = (await view(page)).space.projectId;
  const lines = value(await api(page, 'comparisonLines', { projectId: newId, targetId: documentTarget,
    resultId: text.id, offset: 0, limit: 20 }));
  assert.deepEqual(lines.lines.map(line => line.text), ['Field & lens before', 'Field & lens after']);
  await openComparison(page, pixelTarget);
  await expect(page.getByRole('img', { name: 'Difference mask' })).toBeVisible();
  await button(page, 'Back to Space').click();
  await edit(page, { kind: 'disconnect', id: pixelLinks[0] });
  const revoked = await api(page, 'comparisonPreview', { projectId: newId, targetId: pixelTarget,
    resultId: pixel.id, side: 'difference' });
  assert.equal(revoked.error.code, 'SOURCE_NOT_FOUND');

  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    outcome: 'PASS', documentResultDigest: text.resultDigest, pixelResultDigest: pixel.resultDigest,
    docxEntityDecoded: true, pdfWithoutTextKeptHistory: true, pixelMaskMatched: true,
    pixelComparison: pixel.pixelComparison, restoredTextAndPixels: true, revokedPixelPreviewDenied: true,
    archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  }, null, 2) + '\n');
  console.log('Comparison documents, pixels and restore PASS. Evidence: ' + run);
} finally {
  await app?.close();
}

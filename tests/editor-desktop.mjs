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
const run = await mkdtemp(path.join(parent, 'editor-'));
const project = path.join(run, 'Project');
const archive = path.join(run, 'editor.zip');
const original = path.join(run, 'Source.png');
const replacement = path.join(run, 'Replacement.png');
await mkdir(project);

async function launch(profile) {
  const app = await _electron.launch({ executablePath, args: [root], timeout: 20_000, env: {
    ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile),
  } });
  await app.evaluate(({ dialog }, destination) => {
    globalThis.editorFixture = { files: [], confirm: 0, confirmations: [] };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.editorFixture.files });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    dialog.showMessageBox = async (_owner, options) => {
      if (options.title !== 'Export Editor image' || options.defaultId !== 0 || options.cancelId !== 0) {
        throw new Error('Editor export must have an explicit Cancel default');
      }
      globalThis.editorFixture.confirmations.push(options.detail);
      return { response: globalThis.editorFixture.confirm, checkboxChecked: false };
    };
  }, archive);
  return app;
}

const choose = (app, files) => app.evaluate((_, files) => { globalThis.editorFixture.files = files; }, files);
const confirm = (app, response) => app.evaluate((_, response) => { globalThis.editorFixture.confirm = response; }, response);
const button = (area, name) => area.getByRole('button', { name, exact: true });
const api = (page, method, input) => page.evaluate(([method, input]) => window.forge.project[method](input), [method, input]);
function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const view = page => api(page, 'view').then(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const recipeOf = (snapshot, targetId) => JSON.parse(snapshot.space.nodes.find(node => node.id === targetId).content.payload);
const card = (page, id) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function openProject(app, page, folder) {
  await choose(app, [folder]);
  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  await expect(page.getByRole('heading', { name: 'Editor qualification', exact: true })).toBeVisible();
}
async function openEditor(page, id) {
  await button(page, 'Fit all').click();
  await card(page, id).dblclick();
  const panel = page.getByRole('region', { name: 'Image Editor' });
  await expect(panel).toBeVisible();
  return panel;
}
async function previewPixels(image) {
  return image.evaluate(async element => {
    await element.decode();
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(element, 0, 0);
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
}

let app;
try {
  app = await launch('Original profile');
  let page = await app.firstWindow();
  const [startBytes, nextBytes] = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 6;
    canvas.height = 2;
    const ctx = canvas.getContext('2d');
    const colors = ['#000000', '#283c50', '#283c50', '#0a141e', '#0a141e', '#ffffff'];
    colors.forEach((color, column) => {
      ctx.fillStyle = color;
      ctx.fillRect(column, 0, 1, 2);
    });
    const original = canvas.toDataURL().split(',')[1];
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, 6, 2);
    return [original, canvas.toDataURL().split(',')[1]];
  });
  await Promise.all([writeFile(original, Buffer.from(startBytes, 'base64')), writeFile(replacement, Buffer.from(nextBytes, 'base64'))]);

  await choose(app, [project]);
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Editor qualification');
  await button(page, 'Create project').click();
  await choose(app, [original]);
  await button(page, 'Import files').click();
  await expect(page.getByText('Imported 1 of 1 files')).toBeVisible();
  await button(page, 'Dismiss import results').click();
  await button(page, 'Add Editor').click();
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  const initial = await view(page);
  const projectId = initial.space.projectId;
  const source = initial.space.nodes.find(node => node.content.kind === 'asset');
  const targetId = initial.space.nodes.find(node => node.content.typeId === 'forge.editor').id;
  const originalVersion = source.content.asset;
  await button(page, 'Links').click();
  const linking = page.getByRole('region', { name: 'Data Links' });
  await linking.getByLabel('Source port').selectOption(source.id + ':images');
  await linking.getByLabel('Target port').selectOption(targetId + ':images');
  await button(linking, 'Connect').click();
  await expect(linking.getByText('Source.png · images → Editor · images', { exact: true })).toBeVisible();
  await button(linking, 'Close links').click();
  const inputLink = (await view(page)).space.links[0];

  let panel = await openEditor(page, targetId);
  await panel.getByLabel(/Connected image/).selectOption(originalVersion.versionId);
  for (const operation of ['Crop', 'Resize', 'Exposure', 'Color adjustment']) await button(panel, 'Add ' + operation).click();
  const crop = panel.getByRole('group', { name: 'Crop', exact: true });
  await crop.getByLabel('Left (px)').fill('1');
  await crop.getByLabel('Width (px)').fill('4');
  await crop.getByLabel('Height (px)').fill('2');
  const resize = panel.getByRole('group', { name: 'Resize', exact: true });
  await resize.getByLabel('Width (px)').fill('2');
  await resize.getByLabel('Height (px)').fill('1');
  await panel.getByLabel('Exposure (EV)').fill('1');
  await panel.getByLabel('Red (%)').fill('50');
  await panel.getByLabel('Blue (%)').fill('150');
  const expectedPixels = [40, 120, 240, 255, 10, 40, 90, 255];
  const preview = () => panel.getByRole('img', { name: 'Edited image preview' });
  await button(panel, 'Render preview').click();
  await expect(preview()).toBeVisible();
  assert.deepEqual(await previewPixels(preview()), expectedPixels);
  await button(panel, 'Save recipe').click();
  await expect(panel.getByText('Recipe saved.')).toBeVisible();
  const saved = await view(page);
  const recipe = recipeOf(saved, targetId).recipe;
  assert.deepEqual(recipe.graph.nodes.map(node => node.operation.kind), ['crop', 'resize', 'exposure', 'color']);
  assert.equal(recipe.source.versionId, originalVersion.versionId);
  assert.equal(recipe.source.sha256, digest(Buffer.from(startBytes, 'base64')));
  const request = { projectId, targetId, baseRevision: saved.revision };
  const cycle = randomUUID();
  const bad = await api(page, 'editorPreview', { ...request, operationId: randomUUID(),
    graph: { output: cycle, nodes: [{ id: cycle, input: cycle, operation: { kind: 'resize', width: 2, height: 2 } }] } });
  assert.equal(bad.error.code, 'EDITOR_GRAPH');
  const invalidCrop = await api(page, 'editorPreview', { ...request, operationId: randomUUID(),
    graph: { output: cycle, nodes: [{ id: cycle, input: null, operation: { kind: 'crop', x: 5, y: 1, width: 2, height: 2 } }] } });
  assert.equal(invalidCrop.error.code, 'EDITOR_CROP');

  const readyPreview = await preview().getAttribute('src');
  await resize.getByLabel('Width (px)').fill('4000');
  await resize.getByLabel('Height (px)').fill('2800');
  await panel.evaluate(editor => new Promise((resolve, reject) => {
    const find = label => [...editor.querySelectorAll('button')].find(button => button.textContent === label);
    const timer = setTimeout(() => { watcher.disconnect(); reject(new Error('Cancel preview did not appear')); }, 8_000);
    const watcher = new MutationObserver(() => {
      const cancel = find('Cancel preview');
      if (!cancel) return;
      watcher.disconnect();
      clearTimeout(timer);
      cancel.click();
      resolve();
    });
    watcher.observe(editor, { childList: true, subtree: true });
    find('Render preview').click();
  }));
  await expect(panel.getByText('Preview cancelled.')).toBeVisible();
  assert.equal(await preview().getAttribute('src'), readyPreview);
  assert.equal((await view(page)).revision, saved.revision);
  await button(panel, 'Discard recipe changes').click();

  await panel.getByLabel('Output name').fill('First result');
  await button(panel, 'Export image').click();
  await expect(panel.getByText('Export cancelled.')).toBeVisible();
  assert.equal((await view(page)).revision, saved.revision);
  await confirm(app, 1);
  await button(panel, 'Export image').click();
  await expect(panel.getByText('Exported First result.png to Space.')).toBeVisible();
  const first = recipeOf(await view(page), targetId).exports[0].asset;
  assert.notEqual(first.assetId, originalVersion.assetId);
  assert.notEqual(first.versionId, originalVersion.versionId);
  assert.equal(first.sha256, digest(await readFile(path.join(project, 'assets', 'asset-' + first.versionId + '.png'))));

  await button(page, 'Back to Space').click();
  await button(page, 'Fit all').click();
  await card(page, source.id).dblclick();
  await choose(app, [replacement]);
  await button(page, 'Replace file').click();
  await expect.poll(async () => (await view(page)).space.nodes.find(node => node.id === source.id).content.asset.versionId)
    .not.toBe(originalVersion.versionId);
  await button(page, 'Back to Space').click();
  panel = await openEditor(page, targetId);
  assert.equal(digest(await readFile(path.join(project, 'assets', 'asset-' + originalVersion.versionId + '.png'))), originalVersion.sha256);
  const updatedRevision = (await view(page)).revision;
  const stale = await api(page, 'editorPreview', { ...request, baseRevision: updatedRevision, operationId: randomUUID(),
    graph: recipe.graph, selection: { linkId: inputLink.id, versionId: originalVersion.versionId, sourceRevision: originalVersion.versionId } });
  assert.equal(stale.error.code, 'SOURCE_CHANGED');
  await panel.getByLabel('Output name').fill('Repeat result');
  await button(panel, 'Repeat export').click();
  await expect(panel.getByText('Exported Repeat result.png to Space.')).toBeVisible();
  const second = recipeOf(await view(page), targetId).exports[0].asset;
  assert.equal(second.sha256, first.sha256);
  assert.notEqual(second.assetId, first.assetId);
  await panel.getByLabel('Output format').selectOption('jpeg');
  await panel.getByLabel('Output name').fill('JPEG result');
  await button(panel, 'Export image').click();
  await expect(panel.getByText('Exported JPEG result.jpeg to Space.')).toBeVisible();
  const finalSnapshot = await view(page);
  const savedEditor = recipeOf(finalSnapshot, targetId);
  assert.equal(savedEditor.exports[0].asset.format, 'jpeg');
  const jpeg = await readFile(path.join(project, 'assets', 'asset-' + savedEditor.exports[0].asset.versionId + '.jpeg'));
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  const queries = await app.evaluate(() => globalThis.editorFixture.confirmations);
  assert.deepEqual(queries, ['First result.png', 'First result.png', 'Repeat result.png', 'JPEG result.jpeg']);
  value(await api(page, 'exportBackup', { projectId, baseRevision: finalSnapshot.revision }));
  await app.close();

  app = await launch('Restored profile');
  page = await app.firstWindow();
  await choose(app, [archive]);
  const inspection = value(await api(page, 'inspectBackup'));
  await choose(app, [run]);
  const restored = value(await api(page, 'restoreBackup', inspection.token));
  await openProject(app, page, path.join(run, restored.folder));
  const copied = await view(page);
  assert.notEqual(copied.space.projectId, projectId);
  assert.deepEqual(recipeOf(copied, targetId), savedEditor);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 720));
  panel = await openEditor(page, targetId);
  await button(panel, 'Render preview').click();
  await expect(preview()).toBeVisible();
  assert.deepEqual(await previewPixels(preview()), expectedPixels);
  assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);

  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    outcome: 'PASS', originalSha256: originalVersion.sha256, expectedPixels, exportSha256: first.sha256,
    jpegSha256: savedEditor.exports[0].asset.sha256,
    archiveSha256: digest(await readFile(archive)), graphCycleRejected: true, cropOutsideInputRejected: true,
    canceledDraftRetainedPreviewAndRevision: true, exportConfirmationWasRequired: true,
    staleLinkVersionRejected: true, originalFilePreserved: true, deterministicRepeatAfterReplacement: true,
    recipeAndHistoryRestored: true, narrowPanelFits: true,
  }, null, 2) + '\n');
  console.log('Editor graph, cancellation, deterministic export and restore PASS. Evidence: ' + run);
} finally {
  await app?.close();
}

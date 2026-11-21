import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'import-'));
const project = path.join(run, 'Project');
const inputs = path.join(run, 'Inputs');
await Promise.all([mkdir(project), mkdir(inputs)]);
const first = path.join(inputs, 'first');
const second = path.join(inputs, 'second');
await Promise.all([mkdir(first), mkdir(second)]);
const a = path.join(first, 'requirements.txt');
const b = path.join(second, 'requirements.txt');
const invalid = path.join(inputs, 'invalid.png');
const dropped = path.join(inputs, 'dropped.md');
const image = path.join(root, 'tests', 'fixtures', 'forge-test-grid.png');
const originalMarkdown = '\uFEFF# Dropped fixture\r\n';
await Promise.all([writeFile(a, 'Привет\n'), writeFile(b, 'Different bytes\n'), writeFile(invalid, 'not an image'), writeFile(dropped, originalMarkdown)]);

async function pick(app, filePaths) {
  await app.evaluate(({ dialog }, data) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (options?.properties?.includes('openDirectory')) return { canceled: false, filePaths: [data.project] };
      return { canceled: !data.filePaths.length, filePaths: data.filePaths };
    };
  }, { project, filePaths });
}

async function launch() {
  return _electron.launch({
    executablePath,
    args: [root],
    env: {
      ...process.env, FORGE_QUALIFICATION: '1',
      FORGE_QUALIFICATION_DATA: path.join(run, 'browser'),
    },
  });
}

async function chooseDownload(app, filePath) {
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async (_window, options) => {
      if (options.title !== 'Download original file' || !options.defaultPath || !options.filters?.length) {
        throw new Error('Unexpected save dialog');
      }
      return { canceled: destination === null, filePath: destination ?? '' };
    };
  }, filePath);
}

let app = await launch();
try {
  await pick(app, []);
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Asset fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Asset fixture' })).toBeVisible();
  const importButton = page.getByRole('button', { name: 'Import files', exact: true });
  await importButton.click();
  await expect(page.getByText('Import canceled')).toBeVisible();
  assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 0);

  await pick(app, [a, invalid, b]);
  await importButton.click();
  await expect(page.getByText('Imported 2 of 3 files')).toBeVisible();
  const report = page.getByRole('region', { name: 'Import results' });
  await expect(report.getByText('requirements.txt', { exact: true })).toHaveCount(2);
  await expect(report.getByText('Image data does not match the extension')).toBeVisible();
  const beforeRestart = await page.evaluate(() => window.forge.project.view());
  assert.equal(beforeRestart.value.revision, 1);
  const assets = beforeRestart.value.space.nodes.map(node => node.content.asset);
  assert.equal(assets.length, 2);
  assert.notEqual(assets[0].assetId, assets[1].assetId);
  for (const [index, input] of [a, b].entries()) {
    const bytes = await readFile(input);
    assert.equal(assets[index].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(path.join(project, 'assets', 'asset-' + assets[index].versionId + '.txt')), bytes);
  }
  assert.deepEqual(await readdir(path.join(project, '.forge', 'staging')), []);
  await page.getByRole('button', { name: 'Dismiss import results' }).click();
  const cardSelector = '.react-flow__node[data-id="' + beforeRestart.value.space.nodes[0].id + '"]';
  let card = page.locator(cardSelector);
  await card.dblclick();
  let details = page.getByRole('region', { name: 'File details' });
  let download = details.getByRole('button', { name: 'Download original' });
  await expect(details.getByText(assets[0].sha256)).toBeVisible();
  await expect(details.getByLabel('Text preview')).toContainText('Привет');
  await chooseDownload(app, null);
  await download.click();
  await expect(details.getByText('Download canceled')).toBeVisible();
  const exported = path.join(run, 'download.txt');
  await chooseDownload(app, exported);
  await download.click();
  await expect(details.getByText('Original downloaded')).toBeVisible();
  assert.deepEqual(await readFile(exported), await readFile(a));
  await download.click();
  await expect(details.getByRole('alert')).toHaveText('A file with that name exists. Choose another name');
  assert.deepEqual(await readFile(exported), await readFile(a));
  assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 1);
  await app.close();

  app = await launch();
  page = await app.firstWindow();
  card = page.locator(cardSelector);
  details = page.getByRole('region', { name: 'File details' });
  download = details.getByRole('button', { name: 'Download original' });
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Asset fixture' }).click();
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  assert.deepEqual((await page.evaluate(() => window.forge.project.view())).value.space, beforeRestart.value.space);
  const cdp = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files: [dropped, image], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, x: 550, y: 320, data });
    }
    await expect(page.getByText('Imported 2 of 2 files')).toBeVisible();
    const state = await page.evaluate(() => window.forge.project.view());
    assert.equal(state.value.revision, 2);
    assert.equal(state.value.space.nodes.find(node => node.label === 'dropped.md')?.content.asset.format, 'md');
    const imageCard = state.value.space.nodes.find(node => node.content.asset.format === 'png');
    assert.ok(imageCard);
    await page.getByRole('button', { name: 'Dismiss import results' }).click();
    await page.locator('.react-flow__node[data-id="' + imageCard.id + '"]').dblclick();
    const preview = details.getByRole('img', { name: imageCard.label });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate(image => Math.max(image.naturalWidth, image.naturalHeight))).toBe(512);
    await page.getByRole('button', { name: 'Back to Space' }).click();
  } finally {
    await cdp.detach();
  }
  const originalBlob = path.join(project, 'assets', 'asset-' + assets[0].versionId + '.txt');
  const replacementFile = path.join(inputs, 'updated.txt');
  await writeFile(replacementFile, 'Revised requirements\n');
  await card.dblclick();
  const replace = details.getByRole('button', { name: 'Replace file' });
  await pick(app, []);
  await replace.click();
  await expect(page.getByText('Replacement canceled')).toBeVisible();
  await pick(app, [image]);
  await replace.click();
  await expect(page.getByText('Replacement failed · Choose a replacement with the original format')).toBeVisible();
  assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 2);
  await pick(app, [replacementFile]);
  await replace.click();
  await expect(page.getByText('File replaced', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'updated.txt' })).toBeFocused();
  await expect(details.getByLabel('Text preview')).toContainText('Revised requirements');
  const replaced = (await page.evaluate(() => window.forge.project.view())).value;
  assert.equal(replaced.revision, 3);
  assert.equal(replaced.space.nodes.length, 4);
  const updated = replaced.space.nodes.find(node => node.id === beforeRestart.value.space.nodes[0].id);
  assert.equal(updated.content.asset.assetId, assets[0].assetId);
  assert.notEqual(updated.content.asset.versionId, assets[0].versionId);
  assert.deepEqual(await readFile(originalBlob), await readFile(a));
  await page.getByRole('button', { name: 'Back to Space' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card.getByText('requirements.txt')).toBeVisible();
  const restored = (await page.evaluate(() => window.forge.project.view())).value;
  assert.equal(restored.revision, 4);
  assert.deepEqual(restored.space.nodes[0].content.asset, assets[0]);
  await card.dblclick();
  await expect(details.getByLabel('Text preview')).toContainText('Привет');
  await page.getByRole('button', { name: 'Back to Space' }).click();
  const changed = await readFile(originalBlob);
  changed[changed.length - 1] = 0x20;
  await writeFile(originalBlob, changed);
  await card.dblclick();
  await expect(details.getByRole('alert')).toHaveText('The stored file failed its integrity check');
  await expect(details.getByLabel('Text preview')).toHaveCount(0);
  const rejected = path.join(run, 'rejected.txt');
  await chooseDownload(app, rejected);
  await download.click();
  await expect(details.getByRole('alert')).toHaveCount(2);
  await assert.rejects(readFile(rejected), error => error.code === 'ENOENT');
  assert.equal((await readdir(run)).filter(name => name.startsWith('.forge-export-')).length, 0);
  assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 4);
  await page.getByRole('button', { name: 'Back to Space' }).click();
  const markdown = restored.space.nodes.find(node => node.label === 'dropped.md');
  assert.ok(markdown);
  const markdownCard = page.locator('.react-flow__node[data-id="' + markdown.id + '"]');
  await markdownCard.dblclick();
  await details.getByRole('button', { name: 'Edit text' }).click();
  const field = details.getByLabel('File text');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('# Dropped fixture\n');
  const saveText = details.getByRole('button', { name: 'Save text' });
  await field.fill('𐍈'.repeat(65_537));
  await expect(details.getByRole('alert')).toHaveText('Text exceeds the 256 KiB editor limit');
  await expect(saveText).toBeDisabled();
  const newText = '# Привет 𐍈\nSecond line\n';
  await field.fill(newText);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByText('Save or discard the file changes before leaving.')).toBeVisible();
  await expect(field).toHaveValue(newText);

  const writer = new DatabaseSync(path.join(project, '.forge', 'workspace.sqlite'));
  try {
    writer.exec('BEGIN IMMEDIATE');
    await saveText.click();
    await expect(page.getByText('Text save failed · PROJECT_IO_ERROR')).toBeVisible({ timeout: 7_000 });
    await expect(field).toHaveValue(newText);
    assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 4);
  } finally {
    writer.close();
  }
  await saveText.click();
  await expect(page.getByText('Text saved', { exact: true })).toBeVisible();
  await expect(details.getByLabel('Text preview')).toContainText('# Привет 𐍈');
  const afterEdit = (await page.evaluate(() => window.forge.project.view())).value;
  assert.equal(afterEdit.revision, 5);
  const editedMarkdown = afterEdit.space.nodes.find(node => node.id === markdown.id).content.asset;
  assert.equal(editedMarkdown.assetId, markdown.content.asset.assetId);
  assert.notEqual(editedMarkdown.versionId, markdown.content.asset.versionId);
  const managedFile = asset => path.join(project, 'assets', 'asset-' + asset.versionId + '.md');
  assert.equal(await readFile(managedFile(editedMarkdown), 'utf8'), '\uFEFF' + newText.replaceAll('\n', '\r\n'));
  assert.equal(await readFile(managedFile(markdown.content.asset), 'utf8'), originalMarkdown);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, pickerCancellation: true, perFileBatchResults: true,
    singleRevisionForAcceptedFiles: 1, originalsPreserved: true, duplicateNameSeparateIds: true,
    showsDigestInFileDetails: true, assetNodesAfterRestart: 2, trustedChromiumFileDrop: true,
    utf8TextPreview: true, pngThumbnailMaximumEdge: 512, saveDialogCancellation: true,
    downloadMatchesOriginal: true, existingDestinationPreserved: true,
    sameLengthCorruptionRejectedInPreviewAndDownload: true, noStagedExportAfterRejection: true,
    verifiedReadsDoNotChangeRevision: true,
    replacementCancellationAndInvalidFormatDoNotChangeRevision: true, replacementKeepsCardAndAssetId: true,
    replacementCreatesNewVersionInSingleRevision: true, undoRestoresOriginalVersionAndPreview: true,
    editorRejectsOversizeUtf8: true, dirtyEditorBlocksNavigation: true, busyDatabaseKeepsDraft: true,
    textSavePreservesBomAndCrlf: true, textSaveKeepsOriginalAndCreatesNewVersion: true,
  }, null, 2) + '\n');
  console.log('Asset import, preview, download, replacement and text editor PASS. Evidence: ' + run);
} finally {
  await app.close();
}

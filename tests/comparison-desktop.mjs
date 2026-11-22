import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'comparison-'));
const project = path.join(run, 'Project');
const profile = path.join(run, 'Profile');
await mkdir(project);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
  });
  await app.evaluate(({ dialog }, directory) => {
    globalThis.comparisonPicker = [];
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false, filePaths: options.properties.includes('openDirectory') ? [directory] : globalThis.comparisonPicker,
    });
  }, project);
  return app;
}

let app = await launch();
try {
  let page = await app.firstWindow();
  const plates = (await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    return [[60, 40, '#ff0000', 'png'], [32, 52, '#0000ff', 'jpeg'], [18, 16, '#6fa999', 'png']]
      .map(([width, height, color, format]) => {
        canvas.width = width;
        canvas.height = height;
        context.fillStyle = color;
        context.fillRect(0, 0, width, height);
        return canvas.toDataURL('image/' + format).split(',')[1];
      });
  })).map(bytes => Buffer.from(bytes, 'base64'));
  const unchanged = Array.from({ length: 62 }, (_, index) => 'unchanged ' + (index + 1));
  const leftText = path.join(run, 'draft.txt');
  const rightText = path.join(run, 'revision.md');
  const replacement = path.join(run, 'next-draft.txt');
  const red = path.join(run, 'red.png');
  const blue = path.join(run, 'blue.jpg');
  const tiles = Array.from({ length: 23 }, (_, index) => path.join(run, 'tile-' + (index + 1) + '.png'));
  await Promise.all([
    writeFile(leftText, ['header', 'old text', ...unchanged, 'last'].join('\r\n')),
    writeFile(rightText, ['header', 'new text', ...unchanged, 'last', ''].join('\n')),
    writeFile(replacement, ['header', 'new text', 'Inserted after replacement', ...unchanged, 'last', ''].join('\n')),
    writeFile(red, plates[0]), writeFile(blue, plates[1]), ...tiles.map(file => writeFile(file, plates[2])),
  ]);

  const view = () => page.evaluate(() => window.forge.project.view()).then(reply => reply.value);
  const card = id => page.locator('.react-flow__node[data-id="' + id + '"]');
  const back = () => page.getByRole('button', { name: 'Back to Space', exact: true }).click();
  const compare = () => page.getByRole('region', { name: 'Comparison analysis', exact: true });
  const result = () => page.getByRole('region', { name: 'Comparison result', exact: true });
  const choose = files => app.evaluate((_electron, files) => { globalThis.comparisonPicker = files; }, files);
  const status = input => page.evaluate(input => window.forge.project.comparisonStatus(input), input).then(reply => reply.value);
  const history = input => page.evaluate(input => window.forge.project.comparisonHistory(input), input).then(reply => reply.value);
  const choices = input => page.evaluate(input => window.forge.project.comparisonChoices(input), {
    ...input, offset: input.offset ?? 0, limit: input.limit ?? 100,
  }).then(reply => reply.value);
  async function connect(source, target, label) {
    await page.getByRole('button', { name: 'Links', exact: true }).click();
    const links = page.getByRole('region', { name: 'Data Links' });
    await links.getByLabel('Source port').selectOption(source);
    await links.getByLabel('Target port').selectOption(target);
    await links.getByRole('button', { name: 'Connect', exact: true }).press('Enter');
    await expect(links.getByText(label, { exact: true })).toBeVisible();
    await links.getByRole('button', { name: 'Close links' }).click();
  }
  async function selectPair(leftLink, left, rightLink, right) {
    await compare().getByLabel('Left source').selectOption(leftLink);
    await compare().getByLabel('Left item').selectOption({ label: left });
    await compare().getByLabel('Right source').selectOption(rightLink);
    await compare().getByLabel('Right item').selectOption({ label: right });
  }
  async function imported(number) {
    await expect(page.getByText('Imported ' + number + ' of ' + number + ' files')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss import results' }).click();
  }

  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Comparison qualification');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await choose([leftText, rightText]);
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  await imported(2);
  await page.getByLabel('Add analysis').selectOption('comparison');
  await expect(page.getByText('3 objects · 0 links')).toBeVisible();
  const created = await view();
  const comparison = created.space.nodes.find(node => node.content.typeId === 'forge.comparison');
  const left = created.space.nodes.find(node => node.label === 'draft.txt');
  const right = created.space.nodes.find(node => node.label === 'revision.md');
  const target = { projectId: created.space.projectId, targetId: comparison.id };
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await connect(left.id + ':text', comparison.id + ':sources', 'draft.txt · text → Comparison · sources');
  await connect(right.id + ':files', comparison.id + ':sources', 'revision.md · files → Comparison · sources');
  const linked = await view();
  const linkLeft = linked.space.links.find(link => link.source.nodeId === left.id).id;
  const linkRight = linked.space.links.find(link => link.source.nodeId === right.id).id;
  await card(comparison.id).dblclick();
  await selectPair(linkLeft, 'draft.txt', linkRight, 'revision.md');
  await compare().getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(compare().getByText('Current', { exact: true })).toBeVisible();
  const first = (await status(target)).latest;
  assert.deepEqual([first.mode, first.added, first.removed, first.rows], ['text', 2, 2, 67]);
  assert.deepEqual(first.pair.map(item => item.choice.asset.versionId), [left.content.asset.versionId, right.content.asset.versionId]);
  const diff = result().getByRole('region', { name: 'Text comparison' });
  await expect(diff.getByRole('row').filter({ hasText: 'old text' })).toHaveClass('diff-removed');
  await expect(diff.getByRole('row').filter({ hasText: 'new text' })).toHaveClass('diff-added');
  await diff.getByRole('button', { name: 'Next diff rows' }).click();
  await expect(diff.getByText('No final newline', { exact: true })).toBeVisible();
  const pageOne = await page.evaluate(input => window.forge.project.comparisonLines(input), {
    ...target, resultId: first.id, offset: 0, limit: 3,
  });
  assert.deepEqual(pageOne.value.lines.map(line => [line.kind, line.leftLine, line.rightLine]), [
    ['context', 1, 1], ['removed', 2, null], ['added', null, 2],
  ]);
  await back();

  await card(left.id).dblclick();
  await choose([replacement]);
  await page.getByRole('button', { name: 'Replace file', exact: true }).click();
  await expect(page.getByText('File replaced', { exact: true })).toBeVisible();
  await back();
  await card(comparison.id).dblclick();
  await expect(compare().getByText('Stale', { exact: true })).toBeVisible();
  await expect(diff.getByText('old text', { exact: true })).toBeVisible();
  await selectPair(linkLeft, 'next-draft.txt', linkRight, 'revision.md');
  await compare().getByRole('button', { name: 'Recalculate' }).click();
  await expect(compare().getByText('Current', { exact: true })).toBeVisible();
  await expect(diff.getByText('Inserted after replacement', { exact: true })).toBeVisible();
  const second = (await status(target)).latest;
  assert.notEqual(second.pair[0].choice.asset.versionId, first.pair[0].choice.asset.versionId);
  await compare().getByRole('button', { name: 'Result history' }).click();
  const historyUI = compare().getByRole('region', { name: 'Comparison history' });
  await expect(historyUI.getByRole('button', { name: 'View result' })).toHaveCount(2);
  await historyUI.getByRole('button', { name: 'View result' }).last().click();
  await expect(compare().getByText('Historical result', { exact: true })).toBeVisible();
  await expect(diff.getByText('old text', { exact: true })).toBeVisible();
  await back();

  await page.getByRole('button', { name: 'Add Gallery' }).click();
  await expect(page.getByText('4 objects · 2 links')).toBeVisible();
  await page.getByLabel('Add analysis').selectOption('comparison');
  await expect(page.getByText('5 objects · 2 links')).toBeVisible();
  const createdGallery = await view();
  const gallery = createdGallery.space.nodes.find(node => node.content.typeId === 'forge.gallery');
  const imageCompare = createdGallery.space.nodes.find(node => node.content.typeId === 'forge.comparison' && node.id !== comparison.id);
  const imageTarget = { projectId: target.projectId, targetId: imageCompare.id };
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await card(gallery.id).dblclick();
  await choose([red, ...tiles, blue]);
  await page.getByRole('button', { name: 'Import media', exact: true }).click();
  await imported(25);
  await back();
  await connect(gallery.id + ':images', imageCompare.id + ':sources', 'Gallery · images → Comparison · sources');
  await connect(right.id + ':text', imageCompare.id + ':sources', 'revision.md · text → Comparison · sources');
  const imageView = await view();
  const galleryLink = imageView.space.links.find(link => link.source.nodeId === gallery.id).id;
  const textLink = imageView.space.links.find(link => link.source.nodeId === right.id && link.target.nodeId === imageCompare.id).id;
  const galleryChoices = await choices({ ...imageTarget, linkId: galleryLink });
  const textChoices = await choices({ ...imageTarget, linkId: textLink });
  const selectedVersion = (name, options) => options.items.find(item => item.name === name).asset.versionId;
  await card(imageCompare.id).dblclick();
  await selectPair(galleryLink, 'red.png', textLink, 'revision.md');
  await expect(compare().getByText('Choose two text sources (note, TXT, Markdown, DOCX or PDF), or two images.', { exact: true })).toBeVisible();
  await expect(compare().getByRole('button', { name: 'Calculate' })).toBeDisabled();
  const mixed = await page.evaluate(input => window.forge.project.runComparison(input), {
    ...imageTarget, operationId: randomUUID(), baseRevision: imageView.revision,
    left: { linkId: galleryLink, sourceRevision: galleryChoices.sourceRevision, versionId: selectedVersion('red.png', galleryChoices) },
    right: { linkId: textLink, sourceRevision: textChoices.sourceRevision, versionId: selectedVersion('revision.md', textChoices) },
  });
  assert.equal(mixed.error.code, 'COMPARISON_UNSUPPORTED');
  await compare().getByLabel('Right source').selectOption(galleryLink);
  await compare().getByLabel('Right item').selectOption({ label: 'red.png' });
  await expect(compare().getByText('Choose two different items to compare.', { exact: true })).toBeVisible();
  await compare().getByRole('button', { name: 'Next right items' }).click();
  await compare().getByLabel('Right item').selectOption({ label: 'blue.jpg' });
  await compare().getByRole('button', { name: 'Calculate' }).click();
  await expect(compare().getByText('Current', { exact: true })).toBeVisible();
  const photos = (await status(imageTarget)).latest;
  assert.equal(photos.mode, 'images');
  assert.deepEqual(photos.pixelComparison, { state: 'dimensionsDiffer' });
  await expect(result().getByText('The images have different dimensions. They are shown side by side.')).toBeVisible();
  assert.deepEqual(photos.pair.map(item => item.choice.name), ['red.png', 'blue.jpg']);
  assert.deepEqual(photos.pair.map(item => item.choice.asset.versionId), [
    selectedVersion('red.png', galleryChoices), selectedVersion('blue.jpg', galleryChoices),
  ]);
  const images = result().getByRole('region', { name: 'Image comparison' });
  await expect(images.getByRole('img', { name: 'red.png' })).toBeVisible();
  await expect(images.getByRole('img', { name: 'blue.jpg' })).toBeVisible();
  await images.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const pixels = image.toBitmap();
    let red = false;
    let blue = false;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const [b, g, r] = pixels.subarray(offset, offset + 3);
      red ||= r > 240 && g < 16 && b < 16;
      blue ||= b > 240 && r < 16 && g < 16;
    }
    if (!red || !blue) throw new Error('The captured Comparison should show both images');
    return image.toPNG().toString('base64');
  });
  await writeFile(path.join(run, 'comparison.png'), Buffer.from(screenshot, 'base64'));
  await back();
  await card(gallery.id).dblclick();
  await page.getByRole('button', { name: 'Next items' }).click();
  await page.getByRole('button', { name: 'Remove blue.jpg' }).click();
  await expect(page.getByText('1–24 of 24 media items')).toBeVisible();
  await back();
  await card(imageCompare.id).dblclick();
  await expect(compare().getByText('Stale', { exact: true })).toBeVisible();
  await expect(images.getByRole('img', { name: 'red.png' })).toBeVisible();
  await expect(images.getByRole('img', { name: 'blue.jpg' })).toHaveCount(0);
  await expect(images.getByText('The selected version is outside the connected files')).toBeVisible();

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Comparison qualification' }).click();
  await expect(page.getByText('5 objects · 4 links')).toBeVisible();
  assert.deepEqual((await status(target)).latest, second);
  assert.equal((await history(target)).length, 2);
  assert.equal((await status(imageTarget)).state, 'stale');
  assert.deepEqual((await history(imageTarget))[0].summary, photos);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, textAndFilePorts: true, lineCounts: { added: first.added, removed: first.removed, rows: first.rows },
    textPagedAndFinalNewlinePreserved: true, mixedPairDeniedInUiAndCore: true, duplicateVersionDenied: true,
    gallerySize: galleryChoices.total, pairFromDifferentGalleryPages: true, selectedVersions: photos.pair.map(item => item.choice.asset.versionId),
    correctImagePreviewsRendered: true, removedImageAccessRevoked: true, staleTextAndImageResultsRetained: true,
    historyAndRestartPreserved: true, textResultDigest: second.resultDigest, imageResultDigest: photos.resultDigest,
  }, null, 2) + '\n');
  console.log('Comparison Windows desktop PASS. Evidence: ' + run);
} finally {
  await app.close();
}

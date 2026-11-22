import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'palette-'));
const directory = path.join(run, 'Project');
const profile = path.join(run, 'Profile');
await mkdir(directory);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
  });
  await app.evaluate(({ dialog }, directory) => {
    globalThis.palettePicker = [];
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false, filePaths: options.properties.includes('openDirectory') ? [directory] : globalThis.palettePicker,
    });
  }, directory);
  return app;
}

let app = await launch();
try {
  let page = await app.firstWindow();
  const plates = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    return [[19, 13, '#ff0000'], [641, 317, '#0000ff'], [37, 23, '#00ff0000'], [3011, 3001, '#00ff00']]
      .map(([width, height, color]) => {
        canvas.width = width;
        canvas.height = height;
        context.fillStyle = color;
        context.fillRect(0, 0, width, height);
        return canvas.toDataURL('image/png').split(',')[1];
      });
  });
  const small = ['red.png', 'blue.png', 'transparent.png'].map(name => path.join(run, name));
  const large = Array.from({ length: 6 }, (_, index) => path.join(run, 'large-' + (index + 1) + '.png'));
  await Promise.all([...small.map((file, index) => writeFile(file, Buffer.from(plates[index], 'base64'))),
    ...large.map(file => writeFile(file, Buffer.from(plates[3], 'base64')))]);

  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Palette qualification');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: 'Add Gallery', exact: true }).click();
  await expect(page.getByText('1 objects · 0 links')).toBeVisible();
  await page.getByLabel('Add analysis').selectOption('palette');
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  const view = () => page.evaluate(() => window.forge.project.view()).then(reply => reply.value);
  const created = await view();
  const gallery = created.space.nodes.find(node => node.content.typeId === 'forge.gallery');
  const palette = created.space.nodes.find(node => node.content.typeId === 'forge.palette');
  const target = { projectId: created.space.projectId, targetId: palette.id };
  const card = id => page.locator('.react-flow__node[data-id="' + id + '"]');
  const controls = () => page.getByRole('region', { name: 'Palette analysis', exact: true });
  const result = () => page.getByRole('region', { name: 'Palette result', exact: true });
  const status = () => page.evaluate(input => window.forge.project.paletteStatus(input), target).then(reply => reply.value);
  const history = () => page.evaluate(input => window.forge.project.paletteHistory(input), target).then(reply => reply.value);
  const back = () => page.getByRole('button', { name: 'Back to Space' }).click();
  const openPalette = () => card(palette.id).dblclick();
  async function importImages(files) {
    await card(gallery.id).dblclick();
    await app.evaluate((_electron, files) => { globalThis.palettePicker = files; }, files);
    await page.getByRole('button', { name: 'Import media', exact: true }).click();
    await expect(page.getByText('Imported ' + files.length + ' of ' + files.length + ' files')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss import results' }).click();
    await back();
  }

  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await page.getByRole('button', { name: 'Links', exact: true }).click();
  const links = page.getByRole('region', { name: 'Data Links' });
  await links.getByLabel('Source port').selectOption(gallery.id + ':images');
  await links.getByLabel('Target port').selectOption(palette.id + ':images');
  await links.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(links.getByText('Gallery · images → Palette · images')).toBeVisible();
  await links.getByRole('button', { name: 'Close links' }).click();

  await openPalette();
  await controls().getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  await expect(result().getByText('No visible colors.', { exact: true })).toBeVisible();
  const empty = (await status()).latest;
  assert.equal(empty.itemCount, 0);
  assert.deepEqual(empty.aggregate, []);
  await back();

  await importImages([small[2]]);
  await openPalette();
  await expect(controls().getByText('Stale', { exact: true })).toBeVisible();
  await controls().getByRole('button', { name: 'Recalculate' }).click();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  await expect(result().getByText('1 image · 1 fully transparent')).toBeVisible();
  const transparent = (await status()).latest;
  assert.deepEqual(transparent.aggregate, []);
  assert.notEqual(transparent.resultDigest, empty.resultDigest);
  await back();

  await importImages(small.slice(0, 2));
  await openPalette();
  await expect(controls().getByText('Stale', { exact: true })).toBeVisible();
  await controls().getByLabel('Colors').selectOption('8');
  await controls().getByRole('button', { name: 'Recalculate' }).click();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  const even = (await status()).latest;
  assert.equal(even.colors, 8);
  assert.deepEqual(even.aggregate, [{ hex: '#0000FF', basisPoints: 5000 }, { hex: '#FF0000', basisPoints: 5000 }]);
  await expect(result().getByText('50.00%', { exact: true })).toHaveCount(2);
  await result().getByRole('button', { name: 'Show file palettes' }).click();
  const files = result().getByRole('region', { name: 'File palettes' });
  await expect(files.getByRole('heading', { name: 'red.png' })).toBeVisible();
  const evenFiles = await page.evaluate(input => window.forge.project.paletteFiles(input), {
    ...target, resultId: even.id, offset: 0, limit: 3,
  }).then(reply => reply.value.files);
  assert.equal(new Set(evenFiles.map(file => file.asset.versionId)).size, 3);
  assert.deepEqual(evenFiles.map(file => file.swatches.map(color => color.basisPoints)), [[], [10_000], [10_000]]);
  await result().getByText('Result provenance', { exact: true }).click();
  await expect(result().getByText(even.resultDigest)).toBeVisible();
  await controls().getByRole('button', { name: 'Result history' }).click();
  const earlier = controls().getByRole('region', { name: 'Palette history' });
  await expect(earlier.getByRole('button', { name: 'View result' })).toHaveCount(3);
  await earlier.getByRole('button', { name: 'View result' }).last().click();
  await expect(controls().getByText('Historical result', { exact: true })).toBeVisible();
  await expect(result().getByText('0 images')).toBeVisible();
  await earlier.getByRole('button', { name: 'Show latest result' }).click();
  await expect(result().getByText('50.00%', { exact: true })).toHaveCount(2);
  await back();

  await importImages(large);
  await openPalette();
  await expect(controls().getByText('Stale', { exact: true })).toBeVisible();
  // Observe the rendered control inside the page so driver round trips cannot miss a fast run.
  await page.evaluate(() => {
    const analysis = document.querySelector('[aria-label="Palette analysis"]');
    const observer = new MutationObserver(() => {
      const cancel = Array.from(analysis.querySelectorAll('button')).find(button => button.textContent === 'Cancel analysis');
      if (cancel) {
        observer.disconnect();
        cancel.click();
      }
    });
    observer.observe(analysis, { childList: true, subtree: true });
  });
  await controls().getByRole('button', { name: 'Recalculate' }).click();
  await expect(controls().getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(controls().getByText('Last successful result · Stale', { exact: true })).toBeVisible();
  assert.deepEqual((await status()).latest, even);
  assert.equal((await history()).length, 3);
  await controls().getByLabel('Colors').selectOption('16');
  await controls().getByRole('button', { name: 'Recalculate' }).click();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  const recomputed = (await status()).latest;
  assert.notEqual(recomputed.source.revision, even.source.revision);
  assert.equal(recomputed.colors, 16);
  assert.deepEqual(recomputed.aggregate, [
    { hex: '#00FF00', basisPoints: 7500 }, { hex: '#0000FF', basisPoints: 1250 }, { hex: '#FF0000', basisPoints: 1250 },
  ]);
  assert.equal((await history()).length, 4);
  const retry = await page.evaluate(input => window.forge.project.runPalette(input), {
    ...target, operationId: even.id, baseRevision: even.projectRevision, colors: even.colors,
  });
  assert.deepEqual(retry, { ok: true, value: even });
  const rejectedRetry = await page.evaluate(input => window.forge.project.runPalette(input), {
    ...target, operationId: even.id, baseRevision: even.projectRevision, colors: 16,
  });
  assert.equal(rejectedRetry.error.code, 'INVALID_INPUT');
  const staleRevision = await page.evaluate(input => window.forge.project.runPalette(input), {
    ...target, operationId: crypto.randomUUID(), baseRevision: even.projectRevision, colors: 4,
  });
  assert.equal(staleRevision.error.code, 'REVISION_CONFLICT');
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Palette qualification' }).click();
  await expect(page.getByText('2 objects · 1 links')).toBeVisible();
  await openPalette();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  assert.deepEqual((await status()).latest, recomputed);
  assert.equal((await history()).length, 4);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const screenshot = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true, stayAwake: true,
    });
    const pixels = screenshot.toBitmap();
    const showsGreenSwatch = pixels.some((value, offset) =>
      offset % 4 === 0 && value === 0 && pixels[offset + 1] === 255 && pixels[offset + 2] === 0);
    if (!showsGreenSwatch) throw new Error('The captured window does not show the green palette swatch');
    return screenshot.toPNG().toString('base64');
  });
  assert.ok(image.length > 1000, 'The desktop capture should contain the rendered Palette');
  await writeFile(path.join(run, 'palette.png'), Buffer.from(image, 'base64'));
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, emptyAndTransparent: true, equalWeightDespiteImageSize: true,
    savedParametersAndFileVersions: true, staleAfterGalleryChange: true, cancelPreservedLatestAndHistory: true,
    restartPreservedResults: true, rejectedStaleRevisionAndChangedReplay: true, replayPreservedResult: true,
    historyCount: 4, colors: recomputed.aggregate,
    sourceRevision: recomputed.source.revision, resultDigest: recomputed.resultDigest, algorithm: recomputed.algorithm,
  }, null, 2) + '\n');
  console.log('Palette Windows desktop PASS. Evidence: ' + run);
} finally {
  await app.close();
}

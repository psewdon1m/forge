import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'metadata-'));
const project = path.join(run, 'Project');
const profile = path.join(run, 'Profile');
await mkdir(project);

// Synthetic EXIF with one primary image IFD and one GPS IFD.
function cameraExif() {
  const make = Buffer.from('Forge Camera\0');
  const model = Buffer.from('Qualification Lens\0');
  const primaryOffset = 8;
  const gpsOffset = primaryOffset + 54;
  const latOffset = gpsOffset + 54;
  const lonOffset = latOffset + 24;
  const makeOffset = lonOffset + 24;
  const modelOffset = makeOffset + make.length;
  const tiff = Buffer.alloc(modelOffset + model.length);
  tiff.write('II');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(primaryOffset, 4);
  function ifd(offset, entries) {
    tiff.writeUInt16LE(entries.length, offset);
    entries.forEach(([tag, type, count, value], index) => {
      const field = offset + 2 + index * 12;
      tiff.writeUInt16LE(tag, field);
      tiff.writeUInt16LE(type, field + 2);
      tiff.writeUInt32LE(count, field + 4);
      tiff.writeUInt32LE(value, field + 8);
    });
  }
  ifd(primaryOffset, [
    [0x010f, 2, make.length, makeOffset],
    [0x0110, 2, model.length, modelOffset],
    [0x0112, 3, 1, 6],
    [0x8825, 4, 1, gpsOffset],
  ]);
  ifd(gpsOffset, [
    [1, 2, 2, 'N'.charCodeAt()],
    [2, 5, 3, latOffset],
    [3, 2, 2, 'W'.charCodeAt()],
    [4, 5, 3, lonOffset],
  ]);
  for (const [offset, parts] of [[latOffset, [45, 30, 0]], [lonOffset, [122, 45, 0]]]) {
    parts.forEach((part, index) => {
      tiff.writeUInt32LE(part, offset + index * 8);
      tiff.writeUInt32LE(1, offset + index * 8 + 4);
    });
  }
  make.copy(tiff, makeOffset);
  model.copy(tiff, modelOffset);
  return tiff;
}

function jpegWithExif(jpeg, tiff) {
  assert.deepEqual(jpeg.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const segment = Buffer.from([0xff, 0xe1, 0, 0]);
  segment.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, exif, jpeg.subarray(2)]);
}

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
  });
  await app.evaluate(({ dialog }, directory) => {
    globalThis.metadataPicker = [];
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false,
      filePaths: options.properties.includes('openDirectory') ? [directory] : globalThis.metadataPicker,
    });
  }, project);
  return app;
}

let app = await launch();
try {
  let page = await app.firstWindow();
  const images = (await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    return [[64, 36, 'jpeg'], [33, 21, 'jpeg'], [19, 11, 'png']].map(([width, height, format]) => {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = '#345bab';
      context.fillRect(0, 0, width, height);
      return canvas.toDataURL('image/' + format).split(',')[1];
    });
  })).map(bytes => Buffer.from(bytes, 'base64'));
  const camera = path.join(run, 'camera.jpg');
  const replacement = path.join(run, 'replacement.jpg');
  const damaged = path.join(run, 'damaged-exif.jpg');
  const tiles = Array.from({ length: 24 }, (_, index) => path.join(run, 'tile-' + (index + 1) + '.png'));
  await Promise.all([
    writeFile(camera, jpegWithExif(images[0], cameraExif())),
    writeFile(replacement, images[1]),
    writeFile(damaged, jpegWithExif(images[0], Buffer.from('Unreadable fixture block'))),
    ...tiles.map(file => writeFile(file, images[2])),
  ]);

  const view = () => page.evaluate(() => window.forge.project.view()).then(reply => reply.value);
  const card = id => page.locator('.react-flow__node[data-id="' + id + '"]');
  const back = () => page.getByRole('button', { name: 'Back to Space', exact: true }).click();
  const choose = files => app.evaluate((_electron, files) => { globalThis.metadataPicker = files; }, files);
  const controls = () => page.getByRole('region', { name: 'Metadata analysis', exact: true });
  const result = () => page.getByRole('region', { name: 'Metadata result', exact: true });
  const fields = () => result().getByRole('region', { name: 'Selected file fields' });
  const status = input => page.evaluate(input => window.forge.project.metadataStatus(input), input).then(reply => reply.value);
  const rows = input => page.evaluate(input => window.forge.project.metadataFiles(input), input).then(reply => reply.value);
  async function imported(count) {
    await expect(page.getByText('Imported ' + count + ' of ' + count + ' files')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss import results' }).click();
  }
  async function connect(source, target, label) {
    await page.getByRole('button', { name: 'Links', exact: true }).click();
    const links = page.getByRole('region', { name: 'Data Links' });
    await links.getByLabel('Source port').selectOption(source);
    await links.getByLabel('Target port').selectOption(target);
    await links.getByRole('button', { name: 'Connect', exact: true }).press('Enter');
    await expect(links.getByText(label, { exact: true })).toBeVisible();
    await links.getByRole('button', { name: 'Close links' }).click();
  }

  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Metadata qualification');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await choose([camera]);
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  await imported(1);
  await page.getByLabel('Add analysis').selectOption('metadata');
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  const created = await view();
  const file = created.space.nodes.find(node => node.content.kind === 'asset');
  const metadata = created.space.nodes.find(node => node.content.typeId === 'forge.metadata');
  const target = { projectId: created.space.projectId, targetId: metadata.id };
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await connect(file.id + ':files', metadata.id + ':files', 'camera.jpg · files → Metadata · files');
  await card(metadata.id).dblclick();
  await expect(controls().getByText('Not calculated', { exact: true })).toBeVisible();
  await controls().getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  await expect(fields().getByText('64 × 36 px', { exact: true })).toBeVisible();
  await expect(fields().getByText('Forge Camera', { exact: true })).toBeVisible();
  await expect(fields().getByText('Qualification Lens', { exact: true })).toBeVisible();
  const first = (await status(target)).latest;
  const firstRows = await rows({ ...target, resultId: first.id, offset: 0, limit: 1 });
  assert.equal(firstRows.files[0].asset.versionId, file.content.asset.versionId);
  assert.equal(firstRows.files[0].image.locationAvailable, true);
  assert.equal(Object.hasOwn(firstRows.files[0].image, 'latitude'), false);
  assert.equal(Object.hasOwn(firstRows.files[0].image, 'longitude'), false);
  await expect(fields().getByText('Latitude', { exact: true })).toHaveCount(0);
  await fields().getByRole('button', { name: 'Show EXIF location' }).click();
  await expect(fields().getByText('45.500000°', { exact: true })).toBeVisible();
  await expect(fields().getByText('-122.750000°', { exact: true })).toBeVisible();
  await fields().getByRole('button', { name: 'Hide EXIF location' }).click();
  await expect(fields().getByText('Latitude', { exact: true })).toHaveCount(0);
  await back();

  await card(file.id).dblclick();
  await choose([replacement]);
  await page.getByRole('button', { name: 'Replace file', exact: true }).click();
  await expect(page.getByText('File replaced', { exact: true })).toBeVisible();
  const updated = await view();
  const newVersion = updated.space.nodes.find(node => node.id === file.id).content.asset.versionId;
  assert.notEqual(newVersion, file.content.asset.versionId);
  await back();
  await card(metadata.id).dblclick();
  await expect(controls().getByText('Stale', { exact: true })).toBeVisible();
  await expect(fields().getByText('Forge Camera', { exact: true })).toBeVisible();
  await expect(fields().getByRole('button', { name: 'Show EXIF location' })).toHaveCount(0);
  const revoke = await page.evaluate(input => window.forge.project.metadataLocation(input), {
    ...target, resultId: first.id, versionId: file.content.asset.versionId,
  });
  assert.equal(revoke.error.code, 'SOURCE_CHANGED');
  await controls().getByRole('button', { name: 'Recalculate' }).click();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  await expect(fields().getByText('33 × 21 px', { exact: true })).toBeVisible();
  const second = (await status(target)).latest;
  assert.notEqual(second.source.revision, first.source.revision);
  assert.notEqual(second.resultDigest, first.resultDigest);
  const historical = await rows({ ...target, resultId: first.id, offset: 0, limit: 1 });
  assert.deepEqual(historical, firstRows);
  await controls().getByRole('button', { name: 'Result history' }).click();
  const historyUI = controls().getByRole('region', { name: 'Metadata history' });
  await expect(historyUI.getByRole('button', { name: 'View result' })).toHaveCount(2);
  await historyUI.getByRole('button', { name: 'View result' }).last().click();
  await expect(controls().getByText('Historical result', { exact: true })).toBeVisible();
  await expect(fields().getByText('64 × 36 px', { exact: true })).toBeVisible();
  await back();

  await page.getByRole('button', { name: 'Add Gallery' }).click();
  await expect(page.getByText('3 objects · 1 links')).toBeVisible();
  await page.getByLabel('Add analysis').selectOption('metadata');
  await expect(page.getByText('4 objects · 1 links')).toBeVisible();
  const collection = await view();
  const gallery = collection.space.nodes.find(node => node.content.typeId === 'forge.gallery');
  const metadata2 = collection.space.nodes.find(node => node.content.typeId === 'forge.metadata' && node.id !== metadata.id);
  const target2 = { projectId: target.projectId, targetId: metadata2.id };
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await card(gallery.id).dblclick();
  await choose([camera, damaged, ...tiles]);
  await page.getByRole('button', { name: 'Import media', exact: true }).click();
  await imported(26);
  await back();
  await connect(gallery.id + ':images', metadata2.id + ':files', 'Gallery · images → Metadata · files');
  await card(metadata2.id).dblclick();
  await controls().getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  await expect(result().getByRole('heading', { name: '26 files' })).toBeVisible();
  const full = (await status(target2)).latest;
  assert.equal(full.itemCount, 26);
  await result().getByRole('button', { name: 'damaged-exif.jpg', exact: true }).click();
  await expect(fields().getByText('Unreadable', { exact: true })).toBeVisible();
  await expect(fields().getByText('64 × 36 px', { exact: true })).toBeVisible();
  await result().getByRole('button', { name: 'Next files', exact: true }).click();
  await expect(result().getByRole('button', { name: 'tile-24.png', exact: true })).toBeVisible();
  await result().getByRole('button', { name: 'tile-24.png', exact: true }).click();
  await expect(fields().getByText('19 × 11 px', { exact: true })).toBeVisible();
  const crossCard = await page.evaluate(input => window.forge.project.metadataFiles(input), {
    ...target2, resultId: first.id, offset: 0, limit: 1,
  });
  assert.equal(crossCard.error.code, 'INVALID_INPUT');

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Metadata qualification' }).click();
  await expect(page.getByText('4 objects · 2 links')).toBeVisible();
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await card(metadata2.id).dblclick();
  await expect(controls().getByText('Current', { exact: true })).toBeVisible();
  await expect(result().getByRole('heading', { name: '26 files' })).toBeVisible();
  await expect(fields().getByText('Forge Camera', { exact: true })).toBeVisible();
  await expect(fields().getByText('Latitude', { exact: true })).toHaveCount(0);
  assert.deepEqual((await status(target2)).latest, full);
  assert.deepEqual((await status(target)).latest, second);
  const table = result().getByRole('region', { name: 'Metadata table' });
  await expect(fields().getByText('Forge Camera', { exact: true })).toBeInViewport();
  const wideTable = await table.boundingBox();
  const wideFields = await fields().boundingBox();
  assert.ok(wideFields.x >= wideTable.x + wideTable.width, 'wide window shows fields beside the table');
  const db = new DatabaseSync(path.join(project, '.forge', 'workspace.sqlite'), { readOnly: true });
  try {
    const saved = db.prepare("SELECT cast(result as text) AS result FROM analyses WHERE kind = 'metadata'").all();
    assert.equal(saved.length, 3);
    for (const { result } of saved) {
      for (const file of JSON.parse(result)) {
        assert.equal(Object.hasOwn(file.image ?? {}, 'latitude'), false);
        assert.equal(Object.hasOwn(file.image ?? {}, 'longitude'), false);
      }
      assert.doesNotMatch(result, /45\.5\b|-122\.75\b|GPSLatitude|GPSLongitude/);
    }
  } finally {
    db.close();
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const snapshot = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true, stayAwake: true,
    });
    return snapshot.toPNG().toString('base64');
  });
  assert.ok(image.length > 1000);
  await writeFile(path.join(run, 'metadata.png'), Buffer.from(image, 'base64'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 900));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(970);
  const narrowTable = await table.boundingBox();
  const narrowFields = await fields().boundingBox();
  assert.ok(narrowFields.y >= narrowTable.y + narrowTable.height, 'narrow window places fields below the table');
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, fileToMetadata: true, galleryCount: full.itemCount, galleryPaging: true,
    allowedExifFields: ['Camera make', 'Camera model', 'EXIF orientation'], malformedExifIsolated: true,
    explicitGpsRevealAndHide: true, staleGpsReadDenied: true, noCoordinatesInResultPagesOrSqlite: true,
    exactFileVersions: [file.content.asset.versionId, newVersion],
    resultHistoryRetained: true, crossCardResultDenied: true, restartPreservedResults: true,
    wideFieldsAlongsideTable: true, narrowFieldsBelowTable: true,
    algorithm: full.algorithm, resultDigest: full.resultDigest,
  }, null, 2) + '\n');
  console.log('Metadata Windows desktop PASS. Evidence: ' + run);
} finally {
  await app.close();
}

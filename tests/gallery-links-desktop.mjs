import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'gallery-links-'));
const directory = path.join(run, 'Project');
const profile = path.join(run, 'Profile');
await mkdir(directory);
const red = path.join(run, 'red.png');
const blue = path.join(run, 'blue.jpg');
const rejected = path.join(run, 'reject.txt');
const tiles = Array.from({ length: 25 }, (_, index) => path.join(run, 'tile-' + (index + 1) + '.webp'));

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
  });
  await app.evaluate(({ dialog }, directory) => {
    globalThis.galleryPicker = { files: [], observedTitle: '' };
    dialog.showOpenDialog = async (_owner, options) => {
      globalThis.galleryPicker.observedTitle = options.title;
      return { canceled: false, filePaths: options.properties.includes('openDirectory') ? [directory] : globalThis.galleryPicker.files };
    };
  }, directory);
  return app;
}

let app = await launch();
try {
  let page = await app.firstWindow();
  const plates = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    return [['#ff0000', 'png'], ['#0000ff', 'jpeg'], ['#00ff00', 'webp']].map(([color, format]) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 32, 32);
      const uri = canvas.toDataURL('image/' + format);
      if (!uri.startsWith('data:image/' + format + ';base64,')) throw new Error('Unexpected test encoding');
      return uri.split(',')[1];
    });
  });
  await Promise.all([writeFile(red, Buffer.from(plates[0], 'base64')), writeFile(blue, Buffer.from(plates[1], 'base64')),
    writeFile(rejected, 'Not an image'), ...tiles.map(file => writeFile(file, Buffer.from(plates[2], 'base64')))]);

  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Gallery qualification');
  await page.getByRole('button', { name: 'Create project' }).click();
  await app.evaluate((_electron, files) => { globalThis.galleryPicker.files = files; }, [red]);
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  await expect(page.getByText('Imported 1 of 1 files')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss import results' }).click();
  const view = () => page.evaluate(() => window.forge.project.view()).then(reply => reply.value);
  await page.getByRole('button', { name: 'Add Gallery', exact: true }).click();
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  await page.getByLabel('Add analysis').selectOption('palette');
  await expect(page.getByText('3 objects · 0 links')).toBeVisible();
  await page.getByLabel('Add analysis').selectOption('metadata');
  await expect(page.getByText('4 objects · 0 links')).toBeVisible();
  const first = await view();
  const gallery = first.space.nodes.find(node => node.content.typeId === 'forge.gallery');
  const palette = first.space.nodes.find(node => node.content.typeId === 'forge.palette');
  const metadata = first.space.nodes.find(node => node.content.typeId === 'forge.metadata');
  const redNode = first.space.nodes.find(node => node.content.kind === 'asset');
  const projectId = first.space.projectId;
  const card = id => page.locator('.react-flow__node[data-id="' + id + '"]');
  const fit = () => page.getByRole('button', { name: 'Fit all', exact: true }).click();
  const galleryView = () => page.getByRole('region', { name: 'Gallery', exact: true });
  await fit();
  await card(gallery.id).dblclick();
  await galleryView().getByLabel('Media from Space').selectOption(redNode.content.asset.assetId);
  await galleryView().getByRole('button', { name: 'Add media', exact: true }).click();
  await expect(galleryView().getByRole('img', { name: 'red.png' })).toBeVisible();
  await app.evaluate((_electron, files) => { globalThis.galleryPicker.files = files; }, [blue, rejected, ...tiles]);
  await galleryView().getByRole('button', { name: 'Import media', exact: true }).click();
  await expect(page.getByText('Imported 26 of 27 files')).toBeVisible();
  assert.equal(await app.evaluate(() => globalThis.galleryPicker.observedTitle), 'Import media into Gallery');
  await expect(page.getByRole('region', { name: 'Import results' }).getByText('Gallery accepts PNG, JPEG, WebP, WebM and MP4')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss import results' }).click();
  await expect(galleryView().getByText('1–24 of 27 media items')).toBeVisible();
  await expect(galleryView().getByRole('img', { name: 'blue.jpg' })).toBeVisible();
  const initial = await page.evaluate(input => window.forge.project.galleryPage(input), {
    projectId, nodeId: gallery.id, offset: 0, limit: 2,
  });
  assert.deepEqual(initial.value.items.map(asset => asset.name), ['red.png', 'blue.jpg']);
  await galleryView().getByRole('button', { name: 'Move up blue.jpg', exact: true }).click();
  const galleryList = galleryView().getByRole('list', { name: 'Gallery items' });
  await expect(galleryList.getByRole('listitem').first()).toContainText('blue.jpg');
  await galleryView().getByRole('button', { name: 'Next items', exact: true }).click();
  await expect(galleryView().getByText('25–27 of 27 media items')).toBeVisible();
  await expect(galleryView().getByText('tile-25.webp')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Space' }).click();

  const manager = () => page.getByRole('region', { name: 'Data Links' });
  await page.getByRole('button', { name: 'Links', exact: true }).click();
  await manager().getByLabel('Source port').selectOption(gallery.id + ':images');
  await manager().getByLabel('Target port').selectOption(palette.id + ':images');
  await manager().getByRole('button', { name: 'Connect', exact: true }).press('Enter');
  await expect(manager().getByText('Gallery · images → Palette · images')).toBeVisible();
  await manager().getByRole('button', { name: 'Close links' }).click();

  const source = card(redNode.id).locator('.react-flow__handle.source[data-handleid="files"]');
  const target = card(metadata.id).locator('.react-flow__handle.target[data-handleid="files"]');
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const [from, to] = await Promise.all([source.boundingBox(), target.boundingBox()]);
  assert.ok(from && to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
  await page.mouse.up();
  await expect(page.getByText('4 objects · 2 links')).toBeVisible();
  const linked = await view();
  const paletteLink = linked.space.links.find(link => link.target.nodeId === palette.id);
  const old = await page.evaluate(input => window.forge.project.linkedAssets(input), {
    projectId, targetId: palette.id, linkId: paletteLink.id, sourceRevision: initial.value.sourceRevision, offset: 0, limit: 1,
  });
  assert.equal(old.error.code, 'SOURCE_CHANGED');
  const entire = await page.evaluate(input => window.forge.project.linkedAssets(input), {
    projectId, targetId: palette.id, linkId: paletteLink.id, offset: 0, limit: 100,
  });
  assert.equal(entire.value.total, 27);
  assert.equal(entire.value.items[0].name, 'blue.jpg');
  assert.equal(entire.value.items.at(-1).name, 'tile-25.webp');
  const blueAsset = entire.value.items[0];
  assert.deepEqual(await readFile(path.join(directory, 'assets', 'asset-' + blueAsset.versionId + '.jpeg')), await readFile(blue));
  await card(metadata.id).dblclick();
  await expect(page.getByRole('region', { name: 'Linked source' }).getByText('1 linked files')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Space' }).click();
  await card(gallery.id).click({ button: 'right' });
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm archive' });
  await expect(confirmation.getByText(/1 Data Links/)).toBeVisible();
  await confirmation.getByRole('button', { name: 'Archive objects' }).click();
  await expect(page.getByText('3 objects · 1 links')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('4 objects · 2 links')).toBeVisible();
  const beforeRestart = await view();
  assert.deepEqual(beforeRestart.space.links, linked.space.links);

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Gallery qualification' }).click();
  await expect(page.getByText('4 objects · 2 links')).toBeVisible();
  assert.deepEqual((await view()).space, beforeRestart.space);
  await card(palette.id).dblclick();
  await expect(page.getByRole('region', { name: 'Linked source' }).getByText('27 linked files')).toBeVisible();
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, galleryImageCount: 27, directImportImageOnly: true, addedExistingImageWithoutCopy: true,
    orderAndSourceRevisionChanged: true, thumbnailsAndPagination: true, keyboardLinkForm: true, pointerLink: true,
    metadataSourceRead: true, wholeGalleryLinkedAcrossPages: true, archiveAndUndoRestoredLinks: true, restartRestoredGraph: true,
    beforeRestartRevision: beforeRestart.revision,
  }, null, 2) + '\n');
  console.log('Gallery and Data Links on Windows PASS. Evidence: ' + run);
} finally {
  await app.close();
}

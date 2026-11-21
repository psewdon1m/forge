import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = path.join(root, '.local', 'qualification');
await mkdir(temporary, { recursive: true });
const run = await mkdtemp(path.join(temporary, 'gallery-video-'));
const project = path.join(run, 'Project');
const archive = path.join(run, 'gallery.zip');
const picture = path.join(run, 'Still.png');
const invalid = path.join(run, 'Invalid.mp4');
const names = ['swatches-vp8.webm', 'swatches-vp9.webm', 'swatches-h264.mp4'];
const clips = names.map(name => path.join(root, 'tests', 'fixtures', 'gallery-video', name));
await mkdir(project);
await writeFile(invalid, Buffer.alloc(22, 7));

const button = (area, label) => area.getByRole('button', { name: label, exact: true });
const api = (page, method, input) => page.evaluate(([method, input]) => window.forge.project[method](input), [method, input]);
function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const view = page => api(page, 'view').then(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function launch(profile) {
  const app = await _electron.launch({ executablePath, args: [root], timeout: 20_000, env: {
    ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile),
  } });
  await app.evaluate(({ dialog }, archive) => {
    globalThis.galleryVideoFiles = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.galleryVideoFiles });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: archive });
  }, archive);
  return app;
}
const choose = (app, files) => app.evaluate((_, files) => { globalThis.galleryVideoFiles = files; }, files);

async function openCard(page, id) {
  await button(page, 'Fit all').click();
  await page.locator(`.react-flow__node[data-id="${id}"]`).dblclick();
}
async function dismissedImport(page, message) {
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await button(page, 'Dismiss import results').click();
}
async function assertPoster(gallery, name) {
  const poster = gallery.getByRole('img', { name: 'Poster for ' + name, exact: true });
  await expect(poster).toBeVisible({ timeout: 25_000 });
  const proof = await poster.evaluate(async element => {
    await element.decode();
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(element, 0, 0);
    const left = [...context.getImageData(15, 20, 1, 1).data];
    const right = [...context.getImageData(100, 20, 1, 1).data];
    return { width: canvas.width, height: canvas.height, left, right };
  });
  assert.deepEqual([proof.width, proof.height], [128, 64]);
  assert.ok(proof.left[0] > 150 && proof.left[2] < 100);
  assert.ok(proof.right[2] > 100 && proof.right[0] < 100);
  return proof;
}
async function assertPlayback(area, name) {
  const player = area.getByRole('region', { name: 'Video player' });
  const video = player.locator('video');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('aria-label', name);
  await expect.poll(() => video.evaluate(element => element.readyState), { timeout: 8000 }).toBeGreaterThanOrEqual(1);
  assert.equal(await video.evaluate(element => element.videoWidth), 128);
  assert.equal(await video.evaluate(element => element.videoHeight), 64);
  await video.evaluate(async element => { element.muted = true; await element.play(); });
  await expect.poll(() => video.evaluate(element => element.currentTime), { timeout: 5000 }).toBeGreaterThan(0.08);
  await video.evaluate(element => { element.pause(); element.currentTime = 1.25; });
  await expect.poll(() => video.evaluate(element => !element.seeking && Math.abs(element.currentTime - 1.25) < 0.12))
    .toBe(true);
  const src = await video.getAttribute('src');
  assert.match(src, /^forge-video:\/\/play\/[a-f0-9-]{36}$/);
  return src;
}
async function newMediaRead(page, src) {
  return page.evaluate(src => new Promise(resolve => {
    const video = document.createElement('video');
    // A CORS load requests a fresh stream instead of reusing the non-CORS player's in-memory media.
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    let timer;
    function finish(outcome) {
      clearTimeout(timer);
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
      resolve(outcome);
    }
    timer = setTimeout(() => finish('timeout'), 5000);
    video.onloadeddata = () => finish('decoded');
    video.onerror = () => finish('denied');
    video.src = src;
  }), src);
}

let app;
try {
  app = await launch('First profile');
  let page = await app.firstWindow();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    const context = canvas.getContext('2d');
    context.fillStyle = '#35794b';
    context.fillRect(0, 0, 20, 20);
    return canvas.toDataURL().split(',')[1];
  });
  await writeFile(picture, Buffer.from(png, 'base64'));
  await choose(app, [project]);
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Video qualification');
  await button(page, 'Create project').click();
  await choose(app, [clips[2]]);
  await button(page, 'Import files').click();
  await dismissedImport(page, 'Imported 1 of 1 files');
  await button(page, 'Add Gallery').click();
  await page.getByLabel('Add analysis').selectOption('palette');
  await expect(page.getByText('3 objects · 0 links')).toBeVisible();
  const created = await view(page);
  const source = created.space.nodes.find(node => node.content.kind === 'asset');
  const galleryId = created.space.nodes.find(node => node.content.typeId === 'forge.gallery').id;
  const paletteId = created.space.nodes.find(node => node.content.typeId === 'forge.palette').id;
  const projectId = created.space.projectId;
  await openCard(page, galleryId);
  const gallery = () => page.getByRole('region', { name: 'Gallery', exact: true });
  await gallery().getByLabel('Media from Space').selectOption(source.content.asset.assetId);
  await button(gallery(), 'Add media').click();
  await expect(gallery().getByText('1–1 of 1 media items')).toBeVisible();
  await choose(app, [picture, clips[0], clips[1], invalid]);
  await button(gallery(), 'Import media').click();
  await expect(page.getByText('Invalid MP4 video container', { exact: true })).toBeVisible();
  await dismissedImport(page, 'Imported 3 of 4 files');
  await expect(gallery().getByRole('img', { name: 'Still.png', exact: true })).toBeVisible();
  const posters = {};
  for (const name of names) posters[name] = await assertPoster(gallery(), name);
  const media = value(await api(page, 'galleryPage', { projectId, nodeId: galleryId, offset: 0, limit: 24 }));
  assert.deepEqual(media.items.map(item => item.format), ['mp4', 'png', 'webm', 'webm']);
  for (const name of names) {
    await button(gallery(), 'Open video ' + name).click();
    const src = await assertPlayback(gallery(), name);
    await button(gallery(), 'Close video').click();
    await expect(gallery().getByRole('region', { name: 'Video player' })).toHaveCount(0);
    assert.equal(await newMediaRead(page, src), 'denied', 'Closed video URL for ' + name);
  }
  assert.equal(await app.evaluate(({ session }) => session.fromPartition('forge-video-other').protocol.isProtocolHandled('forge-video')), false);

  await button(page, 'Back to Space').click();
  await openCard(page, source.id);
  const file = page.getByRole('region', { name: 'File details' });
  await button(file, 'Open video').click();
  await assertPlayback(file, names[2]);
  await button(file, 'Close video').click();
  await button(page, 'Back to Space').click();

  await button(page, 'Links').click();
  const links = page.getByRole('region', { name: 'Data Links' });
  await links.getByLabel('Source port').selectOption(galleryId + ':images');
  await links.getByLabel('Target port').selectOption(paletteId + ':images');
  await button(links, 'Connect').click();
  await expect(links.getByText('Gallery · images → Palette · images', { exact: true })).toBeVisible();
  await button(links, 'Close links').click();
  const connected = (await view(page)).space.links.find(item => item.target.nodeId === paletteId).id;
  const asImages = value(await api(page, 'linkedAssets', { projectId, targetId: paletteId, linkId: connected, offset: 0, limit: 24 }));
  assert.deepEqual(asImages.items.map(item => item.name), ['Still.png']);
  assert.equal(asImages.sourceRevision, media.sourceRevision);
  await openCard(page, paletteId);
  const palette = page.getByRole('region', { name: 'Palette analysis' });
  await button(palette, 'Calculate').click();
  await expect(palette.getByText('3 videos skipped', { exact: true })).toBeVisible();
  const result = value(await api(page, 'paletteStatus', { projectId, targetId: paletteId })).latest;
  assert.equal(result.itemCount, 1);
  assert.equal(result.skippedVideos, 3);
  assert.deepEqual(result.aggregate, [{ hex: '#35794B', basisPoints: 10000 }]);
  await button(page, 'Back to Space').click();
  value(await api(page, 'exportBackup', { projectId, baseRevision: (await view(page)).revision }));
  await app.close();

  app = await launch('Restored profile');
  page = await app.firstWindow();
  await choose(app, [archive]);
  const inspection = value(await api(page, 'inspectBackup'));
  await choose(app, [run]);
  const restored = value(await api(page, 'restoreBackup', inspection.token));
  const restoredDirectory = path.join(run, restored.folder);
  await choose(app, [restoredDirectory]);
  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  await expect(page.getByRole('heading', { name: 'Video qualification' })).toBeVisible();
  const newId = (await view(page)).space.projectId;
  assert.notEqual(newId, projectId);
  const restoredMedia = value(await api(page, 'galleryPage', { projectId: newId, nodeId: galleryId, offset: 0, limit: 24 }));
  assert.deepEqual(restoredMedia, media);
  const checksums = {};
  for (const item of restoredMedia.items.filter(item => names.includes(item.name))) {
    checksums[item.name] = digest(await readFile(path.join(restoredDirectory, 'assets', 'asset-' + item.versionId + '.' + item.format)));
    assert.equal(checksums[item.name], item.sha256);
    assert.equal(checksums[item.name], digest(await readFile(clips[names.indexOf(item.name)])));
  }
  await openCard(page, galleryId);
  await assertPoster(gallery(), names[2]);
  await button(gallery(), 'Open video ' + names[2]).click();
  const captured = await assertPlayback(gallery(), names[2]);
  const latest = await view(page);
  const remaining = restoredMedia.items.filter(item => item.name !== names[2]).map(({ assetId, versionId }) => ({ assetId, versionId }));
  value(await api(page, 'apply', { projectId: newId, operationId: randomUUID(), baseRevision: latest.revision,
    change: { kind: 'editGallery', id: galleryId, items: remaining } }));
  assert.equal(await newMediaRead(page, captured), 'denied');
  const stale = await api(page, 'videoOpen', { projectId: newId, nodeId: galleryId, sourceRevision: restoredMedia.sourceRevision,
    versionId: source.content.asset.versionId, format: 'mp4' });
  assert.equal(stale.error.code, 'SOURCE_CHANGED');

  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    outcome: 'PASS', posters, clipBytesPreservedSha256: checksums, archiveSha256: digest(await readFile(archive)),
    profilesPlayedAndSeeked: ['VP8/Opus', 'VP9/Opus', 'H.264/AAC'],
    invalidContainerRejected: true, standaloneFilePlayed: true, revokedOnCloseAndRemoval: true, otherSessionDenied: true,
    paletteImageCount: result.itemCount, paletteSkippedVideos: result.skippedVideos, galleryRestored: true,
  }, null, 2) + '\n');
  console.log('Gallery video, posters, seeking, Palette and restore PASS. Evidence: ' + run);
} finally {
  await app?.close();
}

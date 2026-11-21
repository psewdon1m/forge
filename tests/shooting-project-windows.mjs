import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { CoreClient } from '../apps/desktop/core-client.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'shooting-project-'));
const directory = path.join(run, 'Studio lighting');
const archive = path.join(run, 'Studio lighting.zip');
const destination = path.join(run, 'Restored studio lighting');
const binary = path.join(root, '.local/bin/forge-core.exe');
await mkdir(directory);

function chunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length);
  bytes.write(type, 4, 4, 'ascii');
  payload.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + payload.length)), 8 + payload.length);
  return bytes;
}

const side = 1600;
function plate(rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + 3 * side;
  const rows = Buffer.alloc(stride * side);
  for (let offset = 0; offset < rows.length; offset += stride) rows.fill(Buffer.from(rgb), offset + 1, offset + stride);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const samples = [['Warm key.png', [255, 0, 0]], ['Cool fill.png', [0, 0, 255]], ['Green backdrop.png', [0, 255, 0]]];
const sources = await Promise.all(samples.map(async ([name, rgb]) => {
  const file = path.join(run, name);
  await writeFile(file, plate(rgb));
  return file;
}));

const core = new CoreClient(binary);
let revision = 0;
const call = async (kind, data = {}) => {
  const reply = await core.request({ kind, ...data });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
};
async function apply(change) {
  ({ revision } = await call('apply', { request: { operationId: randomUUID(), baseRevision: revision, change } }));
}

async function portal(type, label, payload, position) {
  const id = randomUUID();
  await apply({ kind: 'add', node: { id, label, position, content: {
    kind: 'portal', plainId: randomUUID(), typeId: 'forge.' + type, schemaVersion: 1, payload: JSON.stringify(payload),
  } } });
  return id;
}

function assetId(asset) {
  return { assetId: asset.assetId, versionId: asset.versionId };
}

const runAnalysis = (kind, targetId, extra) => call(kind, {
  request: { operationId: randomUUID(), baseRevision: revision, targetId, ...extra },
});

try {
  await call('create', { directory, title: 'Studio lighting' });
  const galleryId = await portal('gallery', 'Lighting reference plates', { items: [] }, { x: 25, y: 30 });
  const paletteId = await portal('palette', 'Dominant colors', {}, { x: 370, y: 30 });
  const metadataId = await portal('metadata', 'Image dimensions', {}, { x: 695, y: 30 });
  const checklist = await portal('checklist', 'Shoot preparation', { items: [] }, { x: 25, y: 235 });
  const viewport = { x: 11, y: 18, zoom: 0.87 };
  const camera = randomUUID();
  const key = randomUUID();
  const scheme = await portal('scheme', 'Camera and key light', {
    elements: [
      { id: camera, kind: 'rectangle', position: { x: 54, y: 90 }, width: 146, height: 76, text: 'Camera A' },
      { id: key, kind: 'ellipse', position: { x: 303, y: 90 }, width: 146, height: 76, text: 'Soft key' },
    ],
    lines: [{ id: randomUUID(), from: key, to: camera, text: '45° left', route: 'straight' }],
    viewport,
  }, { x: 370, y: 235 });
  const dataset = await portal('dataset', 'Light settings', { rows: [], columns: [] }, { x: 695, y: 235 });
  const site = await portal('site', 'Lighting reference site', { reference: {
    url: 'https://example.com/', title: 'Example Domain', quote: 'Synthetic fixture quote for the lighting setup.',
  } }, { x: 25, y: 420 });
  await portal('directory', 'Project files', {}, { x: 370, y: 420 });
  const group = randomUUID();
  await apply({ kind: 'editChecklist', id: checklist,
    groups: [{ id: group, label: 'Lighting' }],
    items: [{ id: randomUUID(), label: 'Set the key light', groupId: group, done: true }],
  });
  await apply({ kind: 'importDataset', id: dataset, text: 'Light,Power,Ready,Date\nKey,0.5,true,2026-11-20\nFill,0.25,false,2026-11-20\n',
    options: { delimiter: 'comma', header: true, types: ['string', 'number', 'boolean', 'date'] },
  });
  const imported = await call('importAssets', {
    request: { operationId: randomUUID(), baseRevision: revision, position: { x: 25, y: 630 }, paths: sources.slice(0, 2) },
  });
  revision = imported.revision;
  assert.equal(imported.items.length, 2);
  assert.ok(imported.items.every(item => item.asset && !item.errorCode));
  const [red, blue] = imported.items;
  await apply({ kind: 'editGallery', id: galleryId, items: [assetId(red.asset), assetId(blue.asset)] });
  for (const [targetId, from, to] of [[paletteId, 'images', 'images'], [metadataId, 'files', 'files']]) {
    await apply({ kind: 'connect', id: randomUUID(), source: { nodeId: galleryId, portId: from }, target: { nodeId: targetId, portId: to } });
  }

  const before = await runAnalysis('runPalette', paletteId, { colors: 4 });
  const previousMetadata = await runAnalysis('runMetadata', metadataId);
  assert.deepEqual(before.aggregate, [{ hex: '#0000FF', basisPoints: 5000 }, { hex: '#FF0000', basisPoints: 5000 }]);
  assert.equal(previousMetadata.itemCount, 2);
  ({ revision } = await call('replaceAsset', { request: {
    operationId: randomUUID(), baseRevision: revision, nodeId: red.nodeId, versionId: red.asset.versionId, source: sources[2],
  } }));
  const replaced = (await call('view')).space.nodes.find(node => node.id === red.nodeId).content.asset;
  assert.equal(replaced.assetId, red.asset.assetId);
  assert.notEqual(replaced.versionId, red.asset.versionId);
  await apply({ kind: 'editGallery', id: galleryId, items: [assetId(replaced), assetId(blue.asset)] });
  const cancelId = randomUUID();
  const inProgress = core.request({ kind: 'runPalette',
    request: { operationId: cancelId, baseRevision: revision, targetId: paletteId, colors: 4 },
  });
  await core.cancelAnalysis(cancelId);
  const canceled = await inProgress;
  assert.equal(canceled.ok, false);
  assert.equal(canceled.error.code, 'CANCELLED');
  assert.deepEqual((await call('paletteStatus', { targetId: paletteId })).latest, before);
  const after = await runAnalysis('runPalette', paletteId, { colors: 4 });
  const metadata = await runAnalysis('runMetadata', metadataId);
  assert.notEqual(after.source.revision, before.source.revision);
  assert.deepEqual(after.aggregate, [{ hex: '#0000FF', basisPoints: 5000 }, { hex: '#00FF00', basisPoints: 5000 }]);
  const paletteFiles = result => call('paletteFiles', { targetId: paletteId, resultId: result.id, offset: 0, limit: 20 });
  assert.deepEqual((await paletteFiles(before)).files.map(({ asset }) => asset.versionId), [red.asset.versionId, blue.asset.versionId]);
  assert.deepEqual((await paletteFiles(after)).files.map(({ asset }) => asset.versionId), [replaced.versionId, blue.asset.versionId]);
  const metadataFiles = await call('metadataFiles', { targetId: metadataId, resultId: metadata.id, offset: 0, limit: 20 });
  assert.deepEqual(metadataFiles.files.map(({ image }) => [image.width, image.height]), [[side, side], [side, side]]);
  const paletteHistory = await call('paletteHistory', { targetId: paletteId });
  const metadataHistory = await call('metadataHistory', { targetId: metadataId });
  assert.deepEqual(paletteHistory.map(({ summary }) => summary.resultDigest), [after.resultDigest, before.resultDigest]);
  assert.deepEqual(metadataHistory.map(({ summary }) => summary.resultDigest), [metadata.resultDigest, previousMetadata.resultDigest]);
  await writeFile(path.join(directory, 'Call sheet.md'), '# Lighting setup\nCheck both reference plates before the shoot.\n');
  await call('saveViewport', { viewport });
  const original = await call('view');
  const projectHistory = await call('history', { limit: 100 });
  const exported = await call('createBackup', { baseRevision: revision, destination: archive });
  const restored = await call('restoreBackup', { path: archive, archiveSha256: exported.archiveSha256, destination });
  assert.notEqual(restored.space.projectId, original.space.projectId);
  await call('close');
  const reopened = await call('open', { directory: destination, expectedProjectId: restored.space.projectId });
  assert.deepEqual(reopened.space, { ...original.space, projectId: restored.space.projectId });
  assert.deepEqual(reopened.viewport, viewport);
  const restoredHistory = await call('history', { limit: 100 });
  // A copied project's snapshots include its new project ID and receive new digests.
  const attributes = history => history.map(({ digest, ...entry }) => entry);
  assert.deepEqual(attributes(restoredHistory), attributes(projectHistory));
  assert.ok(restoredHistory.every((entry, index) => /^[0-9a-f]{64}$/.test(entry.digest) && entry.digest !== projectHistory[index].digest));
  assert.deepEqual(await call('paletteHistory', { targetId: paletteId }), paletteHistory);
  assert.deepEqual(await call('metadataHistory', { targetId: metadataId }), metadataHistory);
  assert.equal(await readFile(path.join(destination, 'Call sheet.md'), 'utf8'), await readFile(path.join(directory, 'Call sheet.md'), 'utf8'));
  assert.ok(reopened.space.nodes.some(node => node.id === scheme));
  assert.ok(reopened.space.nodes.some(node => node.id === site));
  const evidence = {
    outcome: 'PASS', directory, archive, destination, revision, projectHistory: projectHistory.length,
    analysisCount: exported.analyses, archiveSha256: exported.archiveSha256,
    sourceVersionVerified: true, canceledRecalculationPreservedHistory: true, restoredProjectAndAnalysisHistory: true,
    projectRevisionDigestsRecomputedForNewId: true,
    resultDigests: { oldPalette: before.resultDigest, newPalette: after.resultDigest, metadata: metadata.resultDigest },
    coreSha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  };
  await writeFile(path.join(run, 'observations.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  core.close();
}

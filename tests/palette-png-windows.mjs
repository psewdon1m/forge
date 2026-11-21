import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { CoreClient } from '../apps/desktop/core-client.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'palette-png-'));
const directory = path.join(run, 'Project');
await mkdir(directory);

function chunk(name, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length);
  bytes.write(name, 4, 4, 'ascii');
  payload.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + payload.length)), 8 + payload.length);
  return bytes;
}

function u32Values(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32BE(value, index * 4));
  return bytes;
}

function makePng({ chunks = [], pixels = [128, 128, 128], depth = 8, alpha = false }) {
  const color = alpha ? 6 : 2;
  const width = pixels.length / (alpha ? 4 : 3);
  const header = Buffer.concat([u32Values([width, 1]), Buffer.from([depth, color, 0, 0, 0])]);
  const row = Buffer.alloc(1 + pixels.length * depth / 8);
  pixels.forEach((value, index) => depth === 8
    ? row.writeUInt8(value, 1 + index)
    : row.writeUInt16BE(value, 1 + index * 2));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...chunks,
    chunk('IDAT', deflateSync(row)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const gamma = value => chunk('gAMA', u32Values([value]));
const srgb = chunk('sRGB', Buffer.from([0]));
const chromaticities = (rx, ry, gx, gy, bx, by) => chunk('cHRM', u32Values([31270, 32900, rx, ry, gx, gy, bx, by]));
const srgbChroma = chromaticities(64000, 33000, 30000, 60000, 15000, 6000);
const p3Chroma = chromaticities(68000, 32000, 26500, 69000, 15000, 6000);
const cicp = (transfer, full = 1) => chunk('cICP', Buffer.from([1, transfer, 0, full]));
const cases = [
  ['default.png', '#808080', makePng({})],
  ['explicit-srgb.png', '#808080', makePng({ chunks: [gamma(100000), srgbChroma, srgb] })],
  ['linear-gamma.png', '#BCBCBC', makePng({ chunks: [gamma(100000), srgbChroma] })],
  ['gamma-only.png', '#898989', makePng({ chunks: [gamma(50000)] })],
  // Reference from the D65 Display P3 → XYZ → sRGB matrices and sRGB transfer curve.
  ['display-p3-chromaticities.png', '#EE4807', makePng({ pixels: [220, 85, 40], chunks: [p3Chroma] })],
  ['linear-cicp.png', '#BCBCBC', makePng({ chunks: [gamma(45455), srgb, cicp(8)] })],
  ['limited-cicp.png', '#808080', makePng({ pixels: [126, 126, 126], chunks: [cicp(13, 0)] })],
  ['linear-16bit.png', '#060606', makePng({ depth: 16, pixels: [128, 128, 128], chunks: [gamma(100000)] })],
  ['alpha-16bit.png', '#FF0000', makePng({ depth: 16, alpha: true, pixels: [65535, 0, 0, 1, 0, 0, 65535, 0] })],
];
await Promise.all(cases.map(([name, , png]) => writeFile(path.join(run, name), png)));
await writeFile(path.join(run, 'hdr.png'), makePng({ chunks: [cicp(16)] }));

const core = new CoreClient(path.join(root, '.local', 'bin', 'forge-core.exe'));
const call = async (kind, data = {}) => {
  const reply = await core.request({ kind, ...data });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
};
const apply = (baseRevision, change) => call('apply', { request: { operationId: randomUUID(), baseRevision, change } });

try {
  await call('create', { directory, title: 'PNG color qualification' });
  const galleryId = randomUUID();
  const targetId = randomUUID();
  const portal = (id, label, typeId, payload) => ({
    kind: 'add', node: { id, label, position: { x: 0, y: 0 }, content: { kind: 'portal', plainId: randomUUID(), typeId, schemaVersion: 1, payload } },
  });
  await apply(0, portal(galleryId, 'Gallery', 'forge.gallery', '{"items":[]}'));
  await apply(1, portal(targetId, 'Palette', 'forge.palette', '{}'));
  const importPng = (baseRevision, names) => call('importAssets', { galleryId, request: {
    operationId: randomUUID(), baseRevision, position: { x: 0, y: 0 }, paths: names.map(name => path.join(run, name)),
  } });
  const imported = await importPng(2, cases.map(([name]) => name));
  assert.equal(imported.items.filter(item => item.asset).length, cases.length);
  const linked = await apply(imported.revision, { kind: 'connect', id: randomUUID(),
    source: { nodeId: galleryId, portId: 'images' }, target: { nodeId: targetId, portId: 'images' } });
  const request = baseRevision => ({ operationId: randomUUID(), baseRevision, targetId, colors: 4 });
  const summary = await call('runPalette', { request: request(linked.revision) });
  assert.equal(summary.algorithm, 'forge.palette.srgb-median-cut.v2');
  const page = await call('paletteFiles', { targetId, resultId: summary.id, offset: 0, limit: 100 });
  assert.equal(page.total, cases.length);
  const checks = cases.map(([name, expected], index) => {
    const file = page.files[index];
    assert.equal(file.asset.name, name);
    assert.equal(file.swatches.length, 1, name);
    assert.equal(file.swatches[0].basisPoints, 10_000, name);
    return { file: name, expected, observed: file.swatches[0].hex };
  });
  assert.deepEqual(checks.map(item => item.observed), checks.map(item => item.expected), JSON.stringify(checks));
  const withHdr = await importPng(linked.revision, ['hdr.png']);
  assert.ok(withHdr.items[0].asset);
  const hdr = await core.request({ kind: 'runPalette', request: request(withHdr.revision) });
  assert.equal(hdr.error.code, 'COLOR_PROFILE_UNSUPPORTED');
  assert.match(hdr.error.message, /tone mapping/);
  const latest = await call('paletteStatus', { targetId });
  assert.equal(latest.state, 'stale');
  assert.deepEqual(latest.latest, summary);
  assert.equal((await call('paletteHistory', { targetId })).length, 1);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, checks, algorithm: summary.algorithm, resultDigest: summary.resultDigest,
    unsupportedHdrCode: hdr.error.code, previousResultAfterFailurePreserved: true,
  }, null, 2) + '\n');
  console.log('Palette PNG color normalization PASS. Evidence: ' + run);
} finally {
  core.close();
}

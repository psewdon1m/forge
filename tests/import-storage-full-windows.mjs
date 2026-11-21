import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreClient } from '../apps/desktop/core-client.mjs';

assert.equal(process.platform, 'win32');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const [run, mount] = process.argv.slice(2);
assert.ok(path.isAbsolute(run) && path.isAbsolute(mount));
assert.equal(path.dirname(mount), run);
assert.equal(path.basename(mount), 'Volume');
const { blocks, bsize } = await statfs(mount);
assert.ok(blocks * bsize > 16 * 1024 * 1024 && blocks * bsize <= 64 * 1024 * 1024, 'Only use the dedicated scratch volume');
const directory = path.join(mount, 'Project');
const kept = path.join(run, 'kept.txt');
const tooLarge = path.join(run, 'large.txt');
const retry = path.join(run, 'retry.txt');
await mkdir(directory);
await Promise.all([writeFile(kept, 'Previously committed text'), writeFile(retry, 'Shorter import')]);
const large = await open(tooLarge, 'wx');
try {
  const block = Buffer.alloc(1024 * 1024, 0x61);
  for (let index = 0; index < 96; index++) assert.equal((await large.write(block)).bytesWritten, block.length);
} finally {
  await large.close();
}

const core = new CoreClient(path.join(root, '.local', 'bin', 'forge-core.exe'));
async function call(command, onProgress) {
  const reply = await core.request(command, { onProgress });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const batch = (baseRevision, source) => ({
  kind: 'importAssets',
  request: { operationId: randomUUID(), baseRevision, paths: [source], position: { x: 0, y: 0 } },
});
try {
  await call({ kind: 'create', directory, title: 'Windows full volume fixture' });
  const first = await call(batch(0, kept));
  assert.equal(first.revision, 1);
  const version = first.items[0].asset;
  assert.ok(version);
  const blob = 'asset-' + version.versionId + '.txt';
  let observedBytes = 0;
  const failed = await call(batch(1, tooLarge), progress => {
    if (progress.phase === 'copying') observedBytes = Math.max(observedBytes, progress.bytes);
  });
  assert.ok(observedBytes > 0, 'The test must fail during copying');
  assert.equal(failed.revision, 1);
  assert.equal(failed.items[0].errorCode, 'STORAGE_FULL');
  assert.deepEqual(await readdir(path.join(directory, 'assets')), [blob]);
  assert.deepEqual(await readdir(path.join(directory, '.forge', 'staging')), []);
  await call({ kind: 'close' });
  const reopened = await call({ kind: 'open', directory });
  assert.equal(reopened.revision, 1);
  assert.deepEqual(await readFile(path.join(directory, 'assets', blob)), await readFile(kept));
  const recovered = await call(batch(1, retry));
  assert.equal(recovered.revision, 2);
  assert.ok(recovered.items[0].asset);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, fileSystem: 'NTFS', volumeCapacity: blocks * bsize, sourceBytes: 96 * 1024 * 1024,
    observedBytes, storageFullError: 'STORAGE_FULL', incompleteCopyRemoved: true, committedBytesUnchanged: true,
    reopenedRevision: 1, shorterImportRevision: 2,
  }, null, 2) + '\n');
  console.log('Windows NTFS storage exhaustion PASS. Evidence: ' + run);
} finally {
  core.close();
  await unlink(tooLarge);
}

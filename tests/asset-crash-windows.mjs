import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'This fixture qualifies hard process termination on Windows');
const root = fileURLToPath(new URL('../', import.meta.url));
const qualification = path.join(root, '.local', 'qualification');
const executable = path.join(root, '.local', 'bin', 'forge-core.exe');
await mkdir(qualification, { recursive: true });
const run = await mkdtemp(path.join(qualification, 'asset-crash-'));
const directory = path.join(run, 'Project');
const staging = path.join(directory, '.forge', 'staging');
const blobs = path.join(directory, 'assets');
await mkdir(directory);
const kept = path.join(run, 'kept.txt');
const discarded = path.join(run, 'discarded.txt');
const large = path.join(run, 'large.txt');
await Promise.all([writeFile(kept, 'Committed original\n'), writeFile(discarded, 'Uncommitted original\n')]);

const block = Buffer.alloc(4 * 1024 * 1024, 0x61);
const largeFile = await open(large, 'wx');
try {
  for (let index = 0; index < 32; index++) {
    assert.equal((await largeFile.write(block)).bytesWritten, block.length);
  }
} finally {
  await largeFile.close();
}

function startCore() {
  const process = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const output = createInterface({ input: process.stdout, crlfDelay: Infinity });
  const lines = output[Symbol.asyncIterator]();
  const closed = once(process, 'close');
  let id = 0;
  return {
    async request(command) {
      const expected = ++id;
      process.stdin.write(JSON.stringify({ id: expected, command }) + '\n');
      for (;;) {
        const next = await lines.next();
        if (next.done) throw new Error('Core closed without a reply');
        const reply = JSON.parse(next.value);
        assert.equal(reply.id, expected);
        if (reply.progress) continue;
        assert.equal(reply.error, undefined, JSON.stringify(reply.error));
        return reply.result;
      }
    },
    kill() {
      assert.equal(process.kill('SIGKILL'), true, 'The live Core must accept termination');
      return closed;
    },
    finish() {
      process.stdin.end();
      return closed;
    },
  };
}

function requestImport(baseRevision, paths, operationId = randomUUID()) {
  return { kind: 'importAssets', request: { operationId, baseRevision, paths, position: { x: 20, y: 30 } } };
}

function dbState() {
  const db = new DatabaseSync(path.join(directory, '.forge', 'workspace.sqlite'), { readOnly: true });
  try {
    return {
      revision: db.prepare('SELECT revision FROM head WHERE id=1').get().revision,
      versions: db.prepare('SELECT COUNT(*) AS count FROM asset_versions').get().count,
      intents: db.prepare('SELECT version_id, bytes FROM asset_intents ORDER BY version_id').all(),
    };
  } finally {
    db.close();
  }
}

const core = startCore();
let childClosed = false;
let committed;
let atStop;
let exit;
const batchId = randomUUID();
try {
  await core.request({ kind: 'create', directory, title: 'Asset crash fixture' });
  const baseline = await core.request(requestImport(0, [kept]));
  assert.equal(baseline.revision, 1);
  committed = baseline.items[0].asset;
  assert.ok(committed);
  const filename = 'asset-' + committed.versionId + '.txt';
  const inflight = core.request(requestImport(1, [discarded, large], batchId)).then(
    result => ({ result }),
    error => ({ error }),
  );
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const [listed, published] = await Promise.all([readdir(staging), readdir(blobs)]);
    const candidate = listed.find(name => /^asset-[a-f0-9-]+\.part$/.test(name));
    if (candidate && published.length > 1) {
      const active = await stat(path.join(staging, candidate)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (active && active.size > 0 && active.size < block.length * 32) {
        atStop = { candidate, bytesObserved: active.size, oldOriginal: filename, published };
        break;
      }
    }
    await delay(1);
  }
  assert.ok(atStop, 'Inspect a partially written file after another blob was published');
  exit = await core.kill();
  childClosed = true;
  assert.equal(exit[1], 'SIGKILL');
  assert.match((await inflight).error?.message ?? '', /closed without a reply/);
  const state = dbState();
  assert.equal(state.revision, 1);
  assert.equal(state.versions, 1);
  assert.equal(state.intents.length, 2);
  assert.ok((await readdir(staging)).includes(atStop.candidate));
  assert.ok((await readdir(blobs)).length > 1);
  atStop.intents = state.intents;
} finally {
  if (!childClosed) await core.finish();
}

const restarted = startCore();
try {
  const reopened = await restarted.request({ kind: 'open', directory });
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.space.nodes.length, 1);
  assert.deepEqual(reopened.space.nodes[0].content.asset, committed);
  assert.deepEqual(dbState(), { revision: 1, versions: 1, intents: [] });
  assert.deepEqual(await readdir(staging), []);
  assert.deepEqual(await readdir(blobs), [atStop.oldOriginal]);
  assert.deepEqual(await readFile(path.join(blobs, atStop.oldOriginal)), await readFile(kept));
  const retry = await restarted.request(requestImport(1, [discarded, large], batchId));
  assert.equal(retry.revision, 2);
  assert.equal(retry.items.filter(item => item.asset).length, 2);
  assert.equal(retry.items[1].asset.bytes, 128 * 1024 * 1024);
  assert.deepEqual(dbState(), { revision: 2, versions: 3, intents: [] });
} finally {
  await restarted.finish();
}
await unlink(large);
await writeFile(path.join(run, 'observations.json'), JSON.stringify({
  platform: process.platform, killedLiveCore: true, exit, atStop, recoveredRevision: 1,
  committedBytesIntact: true, unpublishedBlobAndStageRemoved: true, retriedRevision: 2,
  sameOperationIdRetryAcceptedAllFiles: true,
}, null, 2) + '\n');
console.log('Live asset import interruption and recovery PASS. Evidence: ' + run);

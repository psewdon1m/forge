import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreClient } from '../apps/desktop/core-client.mjs';

assert.equal(process.platform, 'win32');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'directory-core-'));
const directory = path.join(run, 'Project');
const external = path.join(run, 'Outside');
await Promise.all([mkdir(directory), mkdir(external)]);
const core = new CoreClient(path.join(root, '.local', 'bin', 'forge-core.exe'));
const nodeId = randomUUID();

async function ok(command) {
  const reply = await core.request(command);
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}

async function rejected(command, code) {
  const reply = await core.request(command);
  assert.equal(reply.ok, false);
  if (code) assert.equal(reply.error.code, code);
}

const listing = folder => ok({ kind: 'directoryList', nodeId, folder });
const change = (action, baseRevision = 1) => ({ kind: 'directoryChange', nodeId, baseRevision, change: action });
const entry = (list, name) => {
  const file = list.entries.find(item => item.name === name);
  assert.ok(file, name + ' must be in the listing');
  return file;
};

try {
  await ok({ kind: 'create', directory, title: 'Directory safety fixture' });
  await rejected({ kind: 'directoryList', nodeId, folder: [] }, 'INVALID_INPUT');
  await ok({ kind: 'apply', request: { operationId: randomUUID(), baseRevision: 0, change: {
    kind: 'add', node: { id: nodeId, label: 'Directory', position: { x: 0, y: 0 }, content: {
      kind: 'portal', typeId: 'forge.directory', schemaVersion: 1, plainId: randomUUID(), payload: '{}',
    } },
  } } });
  await mkdir(path.join(directory, 'assets'));
  await mkdir(path.join(directory, 'Materials'));
  await writeFile(path.join(directory, 'draft.txt'), 'Original');
  await writeFile(path.join(directory, 'occupied.txt'), 'Keep');
  const outsideFile = path.join(external, 'private.txt');
  await writeFile(outsideFile, 'Outside stays intact');
  await link(outsideFile, path.join(directory, 'hardlink.txt'));
  await symlink(external, path.join(directory, 'junction'), 'junction');

  const before = await listing([]);
  for (const name of ['.forge', 'assets']) {
    assert.equal(before.entries.some(entry => entry.name === name), false);
    await rejected({ kind: 'directoryList', nodeId, folder: [name] }, 'INVALID_INPUT');
  }
  for (const name of ['junction', 'hardlink.txt']) {
    assert.equal(entry(before, name).kind, 'unavailable');
    assert.equal(entry(before, name).version, null);
    await rejected(change({ kind: 'delete', parent: [], name, version: 'forged' }));
  }
  for (const folder of [['junction'], ['..'], [external], ['Materials', '..']]) {
    await rejected({ kind: 'directoryList', nodeId, folder });
  }
  for (const name of ['CON.txt', 'file:stream', 'assets', '..', 'bad.']) {
    await rejected(change({ kind: 'createFolder', parent: [], folderVersion: before.folderVersion, name }), 'INVALID_INPUT');
  }
  await rejected(change({ kind: 'createFolder', parent: [], folderVersion: before.folderVersion, name: 'Never' }, 0), 'REVISION_CONFLICT');
  await ok(change({ kind: 'createFolder', parent: [], folderVersion: before.folderVersion, name: 'New Folder' }));
  await rejected(change({ kind: 'createFolder', parent: [], folderVersion: before.folderVersion, name: 'Stale Folder' }), 'DIRECTORY_CHANGED');

  const source = path.join(directory, 'draft.txt');
  const fixedTime = new Date('2026-01-01T00:00:00Z');
  await utimes(source, fixedTime, fixedTime);
  const draft = entry(await listing([]), 'draft.txt');
  await writeFile(source, 'Modified');
  await utimes(source, fixedTime, fixedTime);
  await rejected(change({ kind: 'rename', parent: [], name: draft.name, version: draft.version, newName: 'revised.txt' }), 'DIRECTORY_CHANGED');
  const revised = entry(await listing([]), 'draft.txt');
  await rejected(change({ kind: 'rename', parent: [], name: revised.name, version: revised.version, newName: 'occupied.txt' }));
  assert.equal(await readFile(path.join(directory, 'occupied.txt'), 'utf8'), 'Keep');
  await ok(change({ kind: 'rename', parent: [], name: revised.name, version: revised.version, newName: 'revised.txt' }));
  const ready = entry(await listing([]), 'revised.txt');
  const destination = ['Materials'];
  const materials = await listing(destination);
  await ok(change({ kind: 'move', parent: [], name: ready.name, version: ready.version, destination, destinationVersion: materials.folderVersion }));
  assert.equal(await readFile(path.join(directory, ...destination, 'revised.txt'), 'utf8'), 'Modified');
  const fullFolder = entry(await listing([]), 'Materials');
  await rejected(change({ kind: 'delete', parent: [], name: fullFolder.name, version: fullFolder.version }));
  const nested = entry(await listing(destination), 'revised.txt');
  await ok(change({ kind: 'delete', parent: destination, name: nested.name, version: nested.version }));
  assert.deepEqual(await readdir(path.join(directory, ...destination)), []);
  const emptyFolder = entry(await listing([]), 'Materials');
  await ok(change({ kind: 'rename', parent: [], name: emptyFolder.name, version: emptyFolder.version, newName: 'Renamed folder' }));
  const renamed = entry(await listing([]), 'Renamed folder');
  await ok(change({ kind: 'delete', parent: [], name: renamed.name, version: renamed.version }));
  assert.equal(await readFile(outsideFile, 'utf8'), 'Outside stays intact');
  assert.deepEqual(await readdir(external), ['private.txt']);
  assert.equal((await ok({ kind: 'view' })).revision, 1);
  await ok({ kind: 'close' });
  await ok({ kind: 'open', directory });
  assert.ok(entry(await listing([]), 'New Folder'));
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, forbiddenEscapeAndInternalStorage: true, junctionAndHardlinkRefused: true,
    staleProjectAndFolderRejected: true, sameSizeContentChangeWithRestoredMtimeRejected: true,
    overwriteRefused: true, createRenameMoveDeleteVerified: true, nonemptyDeleteRejected: true,
    outsideUntouched: true, noGraphRevisionForFilesystemOperations: true, directoryPortalPersists: true,
  }, null, 2) + '\n');
  console.log('Directory Core on Windows PASS. Evidence: ' + run);
} finally {
  core.close();
}

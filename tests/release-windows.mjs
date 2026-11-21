import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron, expect } from '@playwright/test';
import { startUpdateChannel } from './update-channel-fixture.mjs';
import {
  bootstrapName, canonical, ed25519PublicHex, fileDigest, manifestDomain, manifestFor, packageName, rotationDomain, signRecord,
} from '../scripts/release-format.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const execute = promisify(execFile);
const docker = process.argv.includes('--docker');
const discover = process.argv.includes('--updates');
const liveDiscovery = process.argv.includes('--live-discovery');
const failedStartup = process.argv.includes('--failed-startup');
const interruptedStartup = process.argv.includes('--interrupted-startup');
const manualRollback = process.argv.includes('--manual-rollback');
const rollbackCrashes = process.argv.includes('--rollback-crashes');
const candidateTarget = process.argv.includes('--candidate-target');
const slowReadiness = process.argv.includes('--slow-readiness');
const candidateDelayMs = 15_000;
const previousDelayMs = 20_000;
const fullBackupVolume = process.argv.find(value => value.startsWith('--full-backup-volume='))?.slice('--full-backup-volume='.length);
const committed = process.env.GITHUB_ACTIONS === 'true' || process.argv.includes('--committed');
const parent = path.join(root, '.local', 'qualification');
const binaries = path.join(root, '.local', 'bin');
const workspaceVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const candidate = process.env.FORGE_DELIVERY_OUTPUT;
const candidatePublicKey = process.env.FORGE_RELEASE_PUBLIC_KEY_HEX;
if (candidate && !/^[a-f0-9]{64}$/.test(candidatePublicKey ?? '')) throw new Error('A qualified build requires its pinned public key');
if ((candidate || liveDiscovery) && discover) throw new Error('Qualification discovery cannot be included in a candidate or live check');
if ((failedStartup || interruptedStartup || manualRollback) && !discover) throw new Error('Use lifecycle scenarios with --updates');
if ([failedStartup, interruptedStartup, manualRollback].filter(Boolean).length > 1) throw new Error('Select one lifecycle scenario');
if (rollbackCrashes && !manualRollback) throw new Error('Use --rollback-crashes with --manual-rollback');
if (candidateTarget && (!discover || failedStartup || interruptedStartup)) {
  throw new Error('Use --candidate-target with --updates and an unmodified successor');
}
if (slowReadiness && (!manualRollback || candidateTarget || rollbackCrashes)) {
  throw new Error('Use --slow-readiness with --updates --manual-rollback and isolated test packages');
}
if (fullBackupVolume && !discover) throw new Error('Use the disposable backup volume with --updates');
await mkdir(parent, { recursive: true });
await mkdir(binaries, { recursive: true });
const run = await mkdtemp(path.join(parent, 'release-'));
const delivery = candidate ? path.resolve(candidate) : path.join(run, 'Delivery');
const archive = path.join(delivery, packageName(workspaceVersion));
const bootstrap = path.join(delivery, bootstrapName(workspaceVersion));
const setup = candidate ? path.join(binaries, 'forge-launcher.exe') : bootstrap;
const helper = path.join(binaries, 'forge-update-helper.exe');
let localUser = path.join(run, 'Local user');
const project = path.join(run, 'Project');
await Promise.all([mkdir(localUser), mkdir(project)]);

const privateKey = generateKeyPairSync('ed25519').privateKey;
const nextKey = generateKeyPairSync('ed25519').privateKey;
const publicHex = ed25519PublicHex(privateKey);
const testCommit = await commitForQualification();

async function commitForQualification() {
  if (committed) return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return createHash('sha1').update('Forge development qualification without a committed release candidate').digest('hex');
}

function checked(program, args, options = {}) {
  return execFileSync(program, args, { cwd: root, windowsHide: true, encoding: 'utf8', ...options });
}

async function buildWithAnchor(anchor, { workspace = root, qualification = discover && !candidateTarget, buildCore = false } = {}) {
  const env = { ...process.env, FORGE_RELEASE_PUBLIC_KEY_HEX: anchor };
  const features = qualification ? ['--features', 'qualification-discovery'] : [];
  const packages = buildCore ? ['-p', 'forge-update-helper', '-p', 'forge-core'] : ['-p', 'forge-update-helper'];
  const outputs = buildCore ? ['forge-launcher', 'forge-update-helper', 'forge-core'] : ['forge-launcher', 'forge-update-helper'];
  const destination = path.join(workspace, '.local', 'bin');
  await mkdir(destination, { recursive: true });
  if (docker) {
    checked('docker', [
      'run', '--rm', '--env', 'FORGE_RELEASE_PUBLIC_KEY_HEX',
      '--mount', 'type=bind,source=' + workspace + ',target=/forge',
      '--mount', 'type=volume,source=forge-cargo-registry,target=/usr/local/cargo/registry',
      '--mount', 'type=volume,source=forge-cargo-target,target=/forge/target',
      'forge-core-windows-dev:1.94.1', 'bash', '-c',
      'cargo build --locked --release --target x86_64-pc-windows-gnu ' + [...packages, ...features].join(' ') + ' && ' +
        'cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-gnu > .local/release-rust-metadata.json && ' +
        'cp target/x86_64-pc-windows-gnu/release/{' + outputs.join(',') + '}.exe .local/bin/',
    ], { env, stdio: 'inherit' });
  } else {
    checked('cargo', ['build', '--locked', '--release', ...packages, ...features], { cwd: workspace, env, stdio: 'inherit' });
    await writeFile(path.join(workspace, '.local', 'release-rust-metadata.json'),
      checked('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'],
        { cwd: workspace, maxBuffer: 24 * 1024 * 1024 }));
    await Promise.all(outputs.map(output => output + '.exe').map(file =>
      copyFile(path.join(workspace, 'target', 'release', file), path.join(destination, file))));
  }
  return destination;
}

const packageAnchor = candidate ? candidatePublicKey : publicHex;
await buildWithAnchor(packageAnchor);
checked(process.execPath, ['scripts/package-release.mjs', testCommit, delivery], {
  env: { ...process.env, FORGE_RELEASE_PUBLIC_KEY_HEX: packageAnchor }, stdio: 'inherit',
});
if (candidate) await buildWithAnchor(publicHex);

const notes = await readFile(path.join(delivery, 'release-notes.md'), 'utf8');
const manifest = await manifestFor({ version: workspaceVersion, commitSha: testCommit, packagePath: archive, notes });
const signedPath = path.join(candidate ? run : delivery, 'forge-release.json');
const signaturePath = path.join(candidate ? run : delivery, 'forge-release.sig');
let fresh = { ...process.env, LOCALAPPDATA: localUser };
let installation = path.join(localUser, 'Forge', 'Installation');
let activePath = path.join(installation, 'active.json');

async function record(label, data, key = privateKey, domain = manifestDomain) {
  const { bytes, signature } = signRecord(domain, data, key);
  const body = path.join(run, label + '.json');
  const sig = path.join(run, label + '.sig');
  await Promise.all([writeFile(body, bytes), writeFile(sig, signature)]);
  return [body, sig];
}

function reject(program, args, expected, options = {}) {
  const reply = spawnSync(program, args, { cwd: root, windowsHide: true, encoding: 'utf8', ...options });
  assert.equal(reply.status, 1, JSON.stringify({ error: reply.error?.message, stdout: reply.stdout, stderr: reply.stderr }));
  assert.match(reply.stderr, expected);
}

const signed = signRecord(manifestDomain, manifest, privateKey);
await Promise.all([writeFile(signedPath, signed.bytes), writeFile(signaturePath, signed.signature)]);
assert.deepEqual(JSON.parse(checked(helper, ['verify-release', signedPath, signaturePath, archive])), manifest);
assert.equal((await readFile(signedPath, 'utf8')), canonical(manifest));

const untrustedSignature = path.join(run, 'wrong.sig');
await writeFile(untrustedSignature, signRecord(manifestDomain, manifest, nextKey).signature);
reject(setup, ['install', signedPath, untrustedSignature, archive], /signature/i, { env: fresh });
const noncanonical = path.join(run, 'noncanonical.json');
await writeFile(noncanonical, JSON.stringify(manifest, null, 2));
reject(setup, ['install', noncanonical, signaturePath, archive], /canonical/i, { env: fresh });
for (const [label, override, message] of [
  ['wrong-platform', { platform: 'windows-arm64' }, /platform/i],
  ['wrong-channel', { channel: 'testing' }, /channel/i],
  ['wrong-url', { artifact: { ...manifest.artifact, url: manifest.artifact.url + '?redirect=other' } }, /artifact URL/i],
  ['wrong-tag', { tag: 'v' + workspaceVersion }, /tag/i],
  ['wrong-size', { artifact: { ...manifest.artifact, bytes: manifest.artifact.bytes - 1 } }, /size/i],
  ['wrong-compatibility', { compatibility: { ...manifest.compatibility, projectSchemaMin: 2, projectSchemaMax: 2 } }, /incompatible/i],
]) {
  const files = await record(label, { ...manifest, ...override });
  reject(setup, ['install', ...files, archive], message, { env: fresh });
}
const changedArchive = path.join(run, 'changed.zip');
await copyFile(archive, changedArchive);
const mutation = await open(changedArchive, 'r+');
try {
  const byte = Buffer.alloc(1);
  await mutation.read(byte, 0, 1, 52);
  byte[0] ^= 1;
  await mutation.write(byte, 0, 1, 52);
} finally {
  await mutation.close();
}
reject(setup, ['install', signedPath, signaturePath, changedArchive], /digest/i, { env: fresh });
await unlink(changedArchive);
const wrongCommit = await record('wrong-commit', { ...manifest, commitSha: 'f'.repeat(40) });
reject(setup, ['install', ...wrongCommit, archive], /embedded version or commit/i, { env: fresh });
await assert.rejects(stat(activePath), { code: 'ENOENT' });
const pendingInstall = path.join(installation, 'first-install-slot');
let interruptedInstall;
if (candidateTarget) {
  const attempted = await readFile(pendingInstall, 'utf8');
  const installer = spawn(setup, ['install', signedPath, signaturePath, archive], {
    env: fresh, windowsHide: true, stdio: 'ignore',
  });
  const stopped = once(installer, 'close');
  try {
    await expect.poll(async () => {
      const id = await readFile(pendingInstall, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return attempted;
      });
      if (id === attempted) return false;
      interruptedInstall = path.join(installation, 'slots', 'staging-' + id);
      return (await stat(interruptedInstall).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }))?.isDirectory() ?? false;
    }, { intervals: [20], timeout: 12_000 }).toBe(true);
  } finally {
    assert.equal(installer.kill(), true, 'The installer must still be extracting the first slot');
    await stopped;
  }
  await assert.rejects(stat(activePath), { code: 'ENOENT' });
  assert.ok((await stat(interruptedInstall)).isDirectory());
}

const [major, minor, patch] = workspaceVersion.split('.').map(Number);
const overlapVersion = major + '.' + minor + '.' + (patch + 1);
const nextOnlyVersion = major + '.' + minor + '.' + (patch + 2);
const rotation = {
  product: 'forge', schemaVersion: 1, channel: 'stable', nextPublicKey: ed25519PublicHex(nextKey),
  useNextFrom: overlapVersion, retirePreviousAt: nextOnlyVersion,
};
const rotationFiles = await record('trusted-transition', rotation, privateKey, rotationDomain);
const unexpectedRotation = await record('untrusted-transition', rotation, nextKey, rotationDomain);
reject(helper, ['verify-release', signedPath, signaturePath, archive, ...unexpectedRotation], /signature/i);
reject(helper, ['verify-release', signedPath, untrustedSignature, archive, ...rotationFiles], /signature/i);
const nextVersion = await manifestFor({ version: nextOnlyVersion, commitSha: testCommit, packagePath: archive, notes });
const oldKeyAtCutover = await record('retired-key', nextVersion);
const newKeyAtCutover = await record('next-key', nextVersion, nextKey);
reject(helper, ['verify-release', ...oldKeyAtCutover, archive, ...rotationFiles], /signature/i);
checked(helper, ['verify-release', ...newKeyAtCutover, archive, ...rotationFiles]);

let active = JSON.parse(checked(setup, ['install', signedPath, signaturePath, archive, ...rotationFiles], { env: fresh }));
assert.equal(active.version, workspaceVersion);
assert.equal(active.packageSha256, manifest.artifact.sha256);
await assert.rejects(stat(pendingInstall), { code: 'ENOENT' });
if (interruptedInstall) {
  await assert.rejects(stat(interruptedInstall), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(installation, 'slots')), [active.slot]);
}
let installedLauncher = path.join(installation, 'Forge Launcher.exe');
assert.deepEqual(JSON.parse(checked(installedLauncher, ['status'], { env: fresh })), active);
reject(setup, ['install', signedPath, signaturePath, archive], /already installed/i, { env: fresh });
assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
let slot = path.join(installation, 'slots', active.slot);
const referenceSlot = slot;
let installedManifest = manifest;
assert.equal(await fileDigest(path.join(slot, '.forge-install-manifest.json')), await fileDigest(signedPath));
assert.equal(await fileDigest(path.join(slot, '.forge-install-transition.json')), await fileDigest(rotationFiles[0]));

async function startStageFixture() {
  const [major, minor, patch] = workspaceVersion.split('.').map(Number);
  const version = [major, minor, patch + 1].join('.');
  const packagePath = path.join(run, packageName(version));
  await packFixtureRuntime(slot, version, packagePath, async staging => {
    if (failedStartup) {
      // This signed successor fixture exits before sending a health proof.
      await writeFile(path.join(staging, 'resources/app/apps/desktop/main.mjs'), "import { app } from 'electron'; app.exit(1);\n");
    }
    if (interruptedStartup) await delayFixtureReadiness(staging, 30_000);
    if (slowReadiness) await delayFixtureReadiness(staging, candidateDelayMs);
  });
  const newer = await manifestFor({ version, commitSha: testCommit, packagePath, notes: 'Signed notes for the update fixture.' });
  return startUpdateChannel({ run, installed: installedManifest, newer, packagePath, signingKey: privateKey });
}

async function packFixtureRuntime(source, version, packagePath, prepare) {
  const staging = await mkdtemp(path.join(run, 'fixture-runtime-'));
  try {
    await copyFixtureRuntime(source, staging, version);
    await prepare(staging);
    checked(helper, ['pack', staging, packagePath]);
  } finally {
    const resolved = await realpath(staging);
    assert.equal(path.dirname(resolved), await realpath(run));
    assert.match(path.basename(resolved), /^fixture-runtime-[a-zA-Z0-9]+$/);
    await rm(resolved, { recursive: true });
  }
}

async function delayFixtureReadiness(staging, delayMs) {
  const relative = 'resources/app/apps/desktop/update-startup.mjs';
  const source = await readFile(path.join(referenceSlot, relative), 'utf8');
  const begin = 'export async function completeStartup(challenge, window, coreExecutable) {';
  assert.ok(source.includes(begin));
  await writeFile(path.join(staging, relative), source.replace(begin, `${begin}
  await mark(challenge.directory, 'qualification-wait.json', JSON.stringify({
    version: challenge.version, jobId: challenge.jobId, startedAt: Date.now(), delayMs: ${delayMs},
  }));
  await pause(${delayMs});`));
}

async function installDelayedSource() {
  const directory = path.join(run, 'Delayed source');
  await mkdir(directory);
  const packagePath = path.join(directory, packageName(workspaceVersion));
  await packFixtureRuntime(referenceSlot, workspaceVersion, packagePath, staging => delayFixtureReadiness(staging, previousDelayMs));
  installedManifest = await manifestFor({ version: workspaceVersion, commitSha: testCommit, packagePath, notes });
  const release = await record('previous-with-delayed-readiness', installedManifest);
  localUser = path.join(run, 'Delayed source user');
  await mkdir(localUser);
  fresh = { ...process.env, LOCALAPPDATA: localUser };
  installation = path.join(localUser, 'Forge', 'Installation');
  activePath = path.join(installation, 'active.json');
  active = JSON.parse(checked(setup, ['install', ...release, packagePath], { env: fresh }));
  assert.equal(active.version, workspaceVersion);
  assert.equal(active.packageSha256, installedManifest.artifact.sha256);
  installedLauncher = path.join(installation, 'Forge Launcher.exe');
  slot = path.join(installation, 'slots', active.slot);
}

async function copyFixtureRuntime(source, staging, version, commitSha = testCommit) {
  await cp(source, staging, { recursive: true, filter: file => !path.basename(file).startsWith('.forge-install-') });
  for (const relative of ['forge-package.json', 'resources/app/package.json']) {
    const file = path.join(staging, relative);
    const original = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, canonical({ ...original, version, ...(relative === 'forge-package.json' ? { commitSha } : {}) }));
  }
}

async function installPredecessor() {
  const version = '0.0.0';
  if (workspaceVersion === version) throw new Error('Candidate qualification needs a newer release than the fixture');
  const predecessorWorkspace = path.join(run, 'Predecessor source');
  const predecessorRuntime = path.join(run, 'Predecessor runtime');
  const packagePath = path.join(run, packageName(version));
  const commitSha = createHash('sha1').update(`Forge synthetic predecessor of ${testCommit}`).digest('hex');
  await mkdir(predecessorWorkspace);
  await Promise.all([
    cp(path.join(root, 'crates'), path.join(predecessorWorkspace, 'crates'), { recursive: true }),
    copyFile(path.join(root, 'rust-toolchain.toml'), path.join(predecessorWorkspace, 'rust-toolchain.toml')),
  ]);
  const workspaceManifest = await readFile(path.join(root, 'Cargo.toml'), 'utf8');
  const lock = await readFile(path.join(root, 'Cargo.lock'), 'utf8');
  assert.ok(workspaceManifest.includes(`version = "${workspaceVersion}"`));
  const predecessorLock = lock.replace(/(name = "forge-(?:core|update-helper)"\r?\nversion = )"[^"]+"/g, `$1"${version}"`);
  assert.equal([...predecessorLock.matchAll(/name = "forge-(?:core|update-helper)"\r?\nversion = "0\.0\.0"/g)].length, 2);
  await Promise.all([
    writeFile(path.join(predecessorWorkspace, 'Cargo.toml'), workspaceManifest.replace(`version = "${workspaceVersion}"`, `version = "${version}"`)),
    writeFile(path.join(predecessorWorkspace, 'Cargo.lock'), predecessorLock),
    copyFixtureRuntime(referenceSlot, predecessorRuntime, version, commitSha),
  ]);
  const native = await buildWithAnchor(publicHex, { workspace: predecessorWorkspace, qualification: true, buildCore: true });
  const setup = path.join(native, 'forge-launcher.exe');
  const packer = path.join(native, 'forge-update-helper.exe');
  await Promise.all([
    copyFile(packer, path.join(predecessorRuntime, 'forge-update-helper.exe')),
    copyFile(path.join(native, 'forge-core.exe'), path.join(predecessorRuntime, 'resources/bin/forge-core.exe')),
  ]);
  checked(packer, ['pack', predecessorRuntime, packagePath]);
  const installedManifest = await manifestFor({ version, commitSha, packagePath, notes: 'Synthetic predecessor for qualification.' });
  const release = await record('predecessor', installedManifest);
  localUser = path.join(run, 'Predecessor user');
  await mkdir(localUser);
  fresh = { ...process.env, LOCALAPPDATA: localUser };
  installation = path.join(localUser, 'Forge', 'Installation');
  activePath = path.join(installation, 'active.json');
  reject(bootstrap, ['install', ...release, packagePath], /downgrade/i, { env: fresh });
  active = JSON.parse(checked(setup, ['install', ...release, packagePath], { env: fresh }));
  assert.equal(active.version, version);
  assert.equal(active.packageSha256, installedManifest.artifact.sha256);
  installedLauncher = path.join(installation, 'Forge Launcher.exe');
  slot = path.join(installation, 'slots', active.slot);
  return startUpdateChannel({ run, installed: installedManifest, newer: manifest, packagePath: archive, signingKey: privateKey });
}

if (slowReadiness) await installDelayedSource();
const channel = candidateTarget ? await installPredecessor() : discover ? await startStageFixture() : undefined;

async function observeDelayedReadiness(journalPath, phase, expectedVersion, delayMs, previousActive) {
  let observation;
  await expect.poll(async () => {
    const job = JSON.parse(await readFile(journalPath, 'utf8'));
    if (job.phase !== phase) return false;
    for (const directory of await readdir(installation)) {
      if (!/^health-[0-9a-f-]{36}$/.test(directory)) continue;
      const health = path.join(installation, directory);
      const bytes = await readFile(path.join(health, 'qualification-wait.json'), 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!bytes) continue;
      const wait = JSON.parse(bytes);
      if (wait.jobId !== job.id || wait.version !== expectedVersion) continue;
      assert.equal(wait.delayMs, delayMs);
      assert.ok(Number.isSafeInteger(wait.startedAt));
      await assert.rejects(stat(path.join(health, 'ready.json')), { code: 'ENOENT' });
      assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), previousActive);
      observation = wait;
      return Date.now() - wait.startedAt >= delayMs * 0.6;
    }
    return false;
  }, { timeout: 55_000, message: `Wait for ${expectedVersion} to enter its delayed readiness check` }).toBe(true);
  return observation;
}

function completedDelayedReadiness(observation, phase) {
  const elapsedMs = Date.now() - observation.startedAt;
  assert.ok(elapsedMs >= observation.delayMs && elapsedMs < 60_000,
    `Readiness for ${observation.version} completed outside its expected interval: ${elapsedMs} ms`);
  return { version: observation.version, delayMs: observation.delayMs, elapsedMs, phase, activeSlotUnchangedWhileWaiting: true };
}

function fixtureWindows(command) {
  return checked('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...fresh, FORGE_TEST_INSTALLATION: installation }, timeout: 8_000,
  }).trim();
}

const fixtureProcessFilter = `
  $slots = (Join-Path $env:FORGE_TEST_INSTALLATION 'slots') + '\\'
  $editors = Get-CimInstance Win32_Process -Filter "Name = 'Forge.exe'" | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($slots, [StringComparison]::OrdinalIgnoreCase)
  }
`;

function visibleSlot(record) {
  const output = fixtureWindows(fixtureProcessFilter + `
    foreach ($editor in $editors) {
      $runtime = Get-Process -Id $editor.ProcessId -ErrorAction SilentlyContinue
      if ($runtime.MainWindowTitle -eq 'Forge') { [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($editor.ExecutablePath)) }
    }
  `);
  return output.split(/\r?\n/).includes(record.slot);
}

async function exhaustBackupVolume(mount) {
  const fixture = path.dirname(path.normalize(mount));
  assert.equal(path.basename(mount), 'Volume');
  assert.equal(path.dirname(fixture).toLowerCase(), parent.toLowerCase());
  assert.match(path.basename(fixture), /^storage-full-[a-f0-9]{32}$/);
  const capacity = await statfs(mount);
  const capacityBytes = capacity.blocks * capacity.bsize;
  assert.ok(capacityBytes > 16 * 1024 * 1024 && capacityBytes <= 64 * 1024 * 1024, 'Only fill the dedicated scratch volume');
  const file = await open(path.join(mount, 'update-backup-test-fill.bin'), 'wx');
  try {
    for (const size of [1024 * 1024, capacity.bsize]) {
      const chunk = Buffer.alloc(size, 0x5a);
      let full = false;
      for (let offset = 0; offset <= capacityBytes; offset += size) {
        try {
          const result = await file.write(chunk);
          assert.equal(result.bytesWritten, size);
        } catch (error) {
          if (error.code !== 'ENOSPC') throw error;
          full = true;
          break;
        }
      }
      assert.equal(full, true, 'The volume must reject real writes with ENOSPC');
    }
    await file.sync();
  } finally {
    await file.close();
  }
  const { bavail, bsize } = await statfs(mount);
  assert.equal(bavail, 0);
  return { fileSystem: 'NTFS', capacityBytes, availableBytes: bavail * bsize, observedWindowsWriteFailure: 'ENOSPC' };
}

function isFixtureSlotRunning(record) {
  return fixtureWindows(fixtureProcessFilter + `
    foreach ($editor in $editors) { [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($editor.ExecutablePath)) }
  `).split(/\r?\n/).includes(record.slot);
}

function isManualWorkerRunning() {
  return Boolean(fixtureWindows(`
    $launcher = Join-Path $env:FORGE_TEST_INSTALLATION 'Forge Launcher.exe'
    Get-CimInstance Win32_Process -Filter "Name = 'Forge Launcher.exe'" | Where-Object {
      $_.ExecutablePath -eq $launcher -and $_.CommandLine -match ' rollback-update$'
    } | Select-Object -ExpandProperty ProcessId
  `));
}

function stopFixtureLauncher() {
  return fixtureWindows(`
    $launcher = Join-Path $env:FORGE_TEST_INSTALLATION 'Forge Launcher.exe'
    $worker = @(Get-CimInstance Win32_Process -Filter "Name = 'Forge Launcher.exe'" | Where-Object {
      $_.ExecutablePath -eq $launcher -and $_.CommandLine -match ' activate-update$'
    })
    if ($worker.Count -ne 1) { throw 'Expected one fixture launcher handling the update' }
    Stop-Process -Id $worker[0].ProcessId -ErrorAction Stop
    $worker[0].ProcessId
  `);
}

function closeFixtureWindows() {
  fixtureWindows(fixtureProcessFilter + `
    foreach ($editor in $editors) {
      $runtime = Get-Process -Id $editor.ProcessId -ErrorAction SilentlyContinue
      if ($runtime.MainWindowTitle -eq 'Forge') { $null = $runtime.CloseMainWindow() }
    }
    exit 0
  `);
}

let app;
let originalProcess;

async function reopenFixture(record, env) {
  closeFixtureWindows();
  await expect.poll(() => isFixtureSlotRunning(record), { timeout: 15_000 }).toBe(false);
  app = await _electron.launch({
    executablePath: path.join(installation, 'slots', record.slot, 'Forge.exe'),
    env: { ...env, FORGE_INSTALLATION_ROOT: installation },
  });
  originalProcess = app.process();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.hide();
    window.webContents.setBackgroundThrottling(false);
  });
  const window = await app.firstWindow();
  await expect(window.locator('.version')).toHaveText(record.version + ' · Stable');
  return window;
}

async function settingsIn(window) {
  const reply = await window.evaluate(() => window.forge.project.readSettings());
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}

async function openDialog(path) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] };
  }, path);
}

async function verifyProjectVideo(window, expected) {
  const result = await window.evaluate(() => window.forge.project.view());
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const assets = result.value.space.nodes.filter(node => node.content.kind === 'asset').map(node => ({
    nodeId: node.id, ...node.content.asset,
  }));
  assert.deepEqual(assets.map(({ name, format, sha256 }) => ({ name, format, sha256 })), expected);
  for (const { nodeId, versionId } of assets) {
    const reply = await window.evaluate(input => window.forge.project.previewAsset(input), {
      projectId: result.value.space.projectId, nodeId, versionId,
    });
    assert.deepEqual(reply, { ok: true, value: { kind: 'document' } });
  }
}

async function exerciseManualRollback({ current, env, originalSettings, backup, database, projectSha, journalPath, video, failureEvents }) {
  let window = await reopenFixture(current, env);
  let updateDiagnostics;
  if (candidateTarget) {
    const job = JSON.parse(await readFile(journalPath, 'utf8'));
    const archivePath = path.join(run, 'update-diagnostics.zip');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, archivePath);
    await window.getByRole('button', { name: 'Logs', exact: true }).click();
    await window.getByRole('button', { name: 'Download archived logs' }).click();
    await expect(window.getByRole('status').filter({ hasText: 'Diagnostics archive saved.' })).toBeVisible();
    const read = name => checked('tar.exe', ['-xOf', archivePath, name]);
    const diagnostics = JSON.parse(read('manifest.json'));
    assert.equal(diagnostics.sourceVersion, current.version);
    assert.deepEqual(diagnostics.update, {
      installedPackageSha256: current.packageSha256,
      job: {
        id: job.id, phase: 'healthy', sourceVersion: job.previous.version,
        targetVersion: job.targetVersion, targetPackageSha256: job.targetSha256,
      },
    });
    const events = read('events.jsonl').trim().split(/\r?\n/).map(JSON.parse);
    const staged = events.find(event => event.action === 'update-stage' && event.correlationId === job.id);
    assert.equal(staged?.outcome, 'success');
    assert.ok(Number.isSafeInteger(staged.occurredAt) && staged.occurredAt <= diagnostics.createdAt);
    assert.ok(!JSON.stringify(diagnostics).includes(path.basename(backup)));
    for (const expected of failureEvents) {
      const event = events.find(row => row.action === expected.action && row.correlationId === expected.id);
      assert.equal(event?.outcome, 'error');
      assert.deepEqual(event.context, expected.context);
      assert.ok(Number.isSafeInteger(event.occurredAt) && event.occurredAt <= diagnostics.createdAt);
    }
    assert.ok(!JSON.stringify(events).match(/synthetic private response body|token=synthetic|backup-preflight-/));
    updateDiagnostics = {
      archiveSha256: await fileDigest(archivePath), context: diagnostics.update, stagingEventCorrelated: true,
      failureEventsCorrelated: failureEvents,
    };
  }
  await openDialog(project);
  await window.getByRole('button', { name: 'Projects', exact: true }).click();
  await window.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(window.getByRole('heading', { name: 'Installed Forge smoke' })).toBeVisible();
  if (video.length) await verifyProjectVideo(window, video);
  assert.deepEqual(await settingsIn(window), originalSettings);
  const changed = await window.evaluate(state => window.forge.project.saveSettings({
    baseRevision: state.revision, snapToGrid: !state.preferences.snapToGrid,
  }), originalSettings);
  assert.equal(changed.ok, true);
  assert.notDeepEqual(changed.value.preferences, originalSettings.preferences);

  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  let panel = window.getByRole('region', { name: 'Updates', exact: true });
  const rollbackButton = () => panel.getByRole('button', { name: `Roll back to ${active.version}`, exact: true });
  const confirmation = () => window.getByRole('dialog', { name: `Roll back to Forge ${active.version}?` });
  await rollbackButton().press('Enter');
  await expect(confirmation()).toHaveAccessibleDescription(/replaces changes to application settings/);
  await expect(confirmation().getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await window.keyboard.press('Escape');
  await expect(confirmation()).toHaveCount(0);
  await expect(rollbackButton()).toBeFocused();
  await rollbackButton().click();
  await confirmation().getByRole('button', { name: 'Go to project backup' }).click();
  await expect(window.getByRole('button', { name: 'Export project', exact: true })).toBeFocused();

  const unrelated = path.join(run, 'project-backup-before-rollback.zip');
  await app.evaluate(({ dialog }, selected) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
  }, unrelated);
  await window.getByRole('button', { name: 'Export project', exact: true }).click();
  await expect(window.getByText(/Exported and verified revision/)).toBeVisible();
  const tampered = path.join(run, 'tampered-update-backup.zip');
  const bytes = await readFile(backup);
  bytes[0] ^= 1;
  await writeFile(tampered, bytes);
  assert.equal((await stat(tampered)).size, (await stat(backup)).size);
  const runPicker = async selected => {
    await openDialog(selected);
    await rollbackButton().click();
    await confirmation().getByRole('button', { name: 'Choose original ZIP and roll back', exact: true }).click();
  };
  await runPicker(null);
  await expect(rollbackButton()).toBeFocused();
  for (const rejected of [unrelated, tampered]) {
    await runPicker(rejected);
    await expect(panel.getByRole('alert')).toHaveText('Choose the original ZIP saved for this update.');
    assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), current);
    assert.deepEqual(await settingsIn(window), changed.value);
  }

  // Simulate a previous slot whose packaged renderer can no longer start.
  const oldEntry = path.join(slot, 'resources/app/dist/index.html');
  const heldEntry = path.join(run, 'held-previous-index.html');
  const originalEntry = await fileDigest(oldEntry);
  await rename(oldEntry, heldEntry);
  try {
    const exited = once(originalProcess, 'exit', { signal: AbortSignal.timeout(80_000) });
    await runPicker(backup);
    await exited;
    await expect.poll(async () => {
      const job = JSON.parse(await readFile(journalPath, 'utf8'));
      return [job.phase, job.issue];
    }, { timeout: 90_000 }).toEqual(['healthy', 'manualPreviousHealth']);
    assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), current);
    await expect.poll(() => visibleSlot(current), { timeout: 15_000 }).toBe(true);
  } finally {
    await rename(heldEntry, oldEntry);
  }
  assert.equal(await fileDigest(oldEntry), originalEntry);

  window = await reopenFixture(current, env);
  assert.deepEqual(await settingsIn(window), changed.value);
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  panel = window.getByRole('region', { name: 'Updates', exact: true });
  await expect(panel.getByText('The previous version could not start. The update remains installed.')).toBeVisible();
  let rollbackWait;
  if (rollbackCrashes) {
    const interrupt = async checkpoint => {
      await app.close();
      window = await reopenFixture(current, { ...env, FORGE_TEST_MANUAL_ROLLBACK_EXIT: checkpoint });
      await window.getByRole('button', { name: 'Settings', exact: true }).click();
      panel = window.getByRole('region', { name: 'Updates', exact: true });
      const exited = once(originalProcess, 'exit', { signal: AbortSignal.timeout(80_000) });
      await runPicker(backup);
      await exited;
      await expect.poll(async () => JSON.parse(await readFile(journalPath, 'utf8')).phase, { timeout: 80_000 }).toBe('manualCommitting');
      await expect.poll(() => isManualWorkerRunning() || isFixtureSlotRunning(active), { timeout: 15_000 }).toBe(false);
      assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), current);
      const recovered = spawn(installedLauncher, [], { env, stdio: 'ignore', windowsHide: true });
      assert.deepEqual(await once(recovered, 'exit', { signal: AbortSignal.timeout(70_000) }), [0, null]);
    };
    await interrupt('before-settings-commit');
    const unchanged = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(unchanged.phase, 'healthy');
    assert.equal(unchanged.issue, 'manualInterrupted');
    assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), current);
    await expect.poll(() => visibleSlot(current), { timeout: 15_000 }).toBe(true);
    window = await reopenFixture(current, env);
    assert.deepEqual(await settingsIn(window), changed.value);
    await interrupt('after-settings-commit');
  } else {
    const exited = once(originalProcess, 'exit', { signal: AbortSignal.timeout(80_000) });
    await runPicker(backup);
    await exited;
    if (slowReadiness) rollbackWait = await observeDelayedReadiness(journalPath, 'manualStarting', active.version, previousDelayMs, current);
  }
  await expect.poll(async () => JSON.parse(await readFile(journalPath, 'utf8')).phase, { timeout: 90_000 }).toBe('manualRolledBack');
  const readiness = rollbackWait && completedDelayedReadiness(rollbackWait, 'manualRolledBack');
  assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
  await expect.poll(() => visibleSlot(active), { timeout: 15_000 }).toBe(true);
  const returned = JSON.parse(checked(path.join(slot, 'forge-update-helper.exe'), ['update-status'], { env }));
  assert.equal(returned.lastJob.phase, 'manualRolledBack');
  assert.equal(returned.lastJob.canRollBack, false);
  assert.equal(await fileDigest(database), projectSha);
  window = await reopenFixture(active, env);
  const restored = await settingsIn(window);
  assert.deepEqual(restored.preferences, originalSettings.preferences);
  assert.equal(restored.revision, changed.value.revision + 1);
  await window.getByRole('button', { name: 'Settings', exact: true }).click();
  panel = window.getByRole('region', { name: 'Updates', exact: true });
  await expect(panel.getByText('Rollback complete', { exact: true })).toBeVisible();
  await writeFile(path.join(run, 'updates-rollback-panel.txt'), await panel.ariaSnapshot({ timeout: 5_000 }) + '\n');
  if (video.length) {
    await openDialog(project);
    await window.getByRole('button', { name: 'Projects', exact: true }).click();
    await window.getByRole('button', { name: 'Open project', exact: true }).click();
    await expect(window.getByRole('heading', { name: 'Installed Forge smoke' })).toBeVisible();
    await verifyProjectVideo(window, video);
  }
  return {
    updatedVersion: current.version, restoredVersion: active.version, projectSha256: projectSha,
    ...(readiness && { readiness }),
    oldSettings: originalSettings, changedSettings: changed.value, restoredSettings: restored,
    cancellationPreservedActiveVersion: true, originalZipVerified: true, invalidZipRejected: true,
    separateProjectBackup: true, unsuccessfulRollbackKeptCurrentVersionAndSettings: true,
    originalProjectUnchanged: true, ordinaryRestartRestoredSettings: true,
    ...(updateDiagnostics ? { updateDiagnostics } : {}),
    ...(video.length ? { verifiedVideoOnCandidateAndRollback: video } : {}),
    keyboardConfirmationAndPickerCancelRestoredFocus: true,
    ...(rollbackCrashes ? { resumedBeforeAndAfterSettingsCommit: true } : {}),
  };
}

try {
  const videoFiles = candidateTarget ? ['swatches-h264.mp4', 'swatches-vp8.webm']
    .map(name => path.join(root, 'tests', 'fixtures', 'gallery-video', name)) : [];
  const video = await Promise.all(videoFiles.map(async file => ({
    name: path.basename(file), format: path.extname(file).slice(1), sha256: await fileDigest(file),
  })));
  app = await _electron.launch({
    executablePath: path.join(slot, 'Forge.exe'),
    env: {
      ...fresh,
      ...channel?.env,
      ...(liveDiscovery ? {
        FORGE_TEST_DISCOVERY_ORIGIN: 'https://127.0.0.1:1/',
        FORGE_TEST_DISCOVERY_CA: path.join(run, 'nonexistent-test-ca.pem'),
      } : {}),
      FORGE_INSTALLATION_ROOT: installation,
    },
  });
  originalProcess = app.process();
  await app.evaluate(({ BrowserWindow, dialog, session }, { dir, videoFiles }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.hide();
    window.webContents.setBackgroundThrottling(false);
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false,
      filePaths: options.properties.includes('multiSelections') && videoFiles.length ? videoFiles : [dir],
    });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }));
  }, { dir: project, videoFiles });
  const window = await app.firstWindow();
  await expect(window.locator('.version')).toHaveText(active.version + ' · Stable');
  await window.getByRole('button', { name: 'Projects', exact: true }).click();
  await window.getByLabel('Project name').fill('Installed Forge smoke');
  await window.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(window.getByRole('heading', { name: 'Installed Forge smoke' })).toBeVisible();
  await window.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(window.getByText('1 objects · 0 links')).toBeVisible();
  if (video.length) {
    await window.getByRole('button', { name: 'Import files', exact: true }).click();
    await expect(window.getByText('Imported 2 of 2 files')).toBeVisible();
    await window.getByRole('button', { name: 'Dismiss import results' }).click();
    await verifyProjectVideo(window, video);
  }
  const check = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged, userData: app.getPath('userData'), electron: process.versions.electron,
  }));
  assert.equal(check.packaged, true);
  assert.equal(check.userData, path.join(localUser, 'Forge', 'Profile'));
  const discovery = {};
  if (!candidate) {
    if (channel) assert.equal(channel.requests.length, 0);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    const updates = window.getByRole('region', { name: 'Updates', exact: true });
    const button = updates.getByRole('button', { name: 'Check for updates' });
    await expect(updates.getByText('Ready to check', { exact: true })).toBeVisible();
    await expect(updates.getByText(active.version, { exact: true })).toBeVisible();
    assert.equal(channel?.requests.length ?? 0, 0);
    if (channel) {
      channel.delay();
      await button.click();
      await expect(updates.getByText('Checking…', { exact: true })).toBeVisible();
      await expect(button).toBeDisabled();
      await expect.poll(() => channel.waiting).toBe(true);
      channel.release();
      await expect(updates.getByText('Up to date', { exact: true })).toBeVisible();
      channel.select('available');
      await button.click();
      await expect(updates.getByText('Update available', { exact: true })).toBeVisible();
      await expect(updates.getByRole('heading', { name: 'Forge ' + channel.nextVersion })).toBeVisible();
      const shownNotes = updates.locator('.updates-release-notes');
      await expect(shownNotes).toHaveText(channel.releaseNotes);
      const availablePanel = await updates.ariaSnapshot({ timeout: 5_000 });
      await writeFile(path.join(run, 'updates-panel.txt'), availablePanel + '\n');

      for (const [mode, label, detail] of [
        ['incompatible', 'Incompatible', 'requires a different Windows, updater or project schema version.'],
        ['badSignature', 'Error', 'Forge could not verify the published release and its signature.'],
        ['wrongChannel', 'Error', 'Forge could not verify the published release and its signature.'],
        ['conflict', 'Error', 'The published release conflicts with the installed version or digest.'],
        ['redirect', 'Error', 'The Stable release channel could not respond safely.'],
        ['empty', 'Error', 'The Stable channel has no published immutable Forge release.'],
      ]) {
        channel.select(mode);
        await button.click();
        await expect(updates.getByText(label, { exact: true })).toBeVisible();
        await expect(updates.getByText(detail, { exact: mode !== 'incompatible' })).toBeVisible();
        await expect(shownNotes).toHaveCount(0);
      }
      assert.equal(channel.requests.filter(request => request.path === '/repos/psewdon1m/forge/releases').length, 8);
      assert.ok(channel.requests.every(request => request.cache === 'no-cache, no-store' && request.pragma === 'no-cache'));
      assert.ok(channel.requests.some(request => request.path === '/forge-qualification/manifest'));
      assert.ok(channel.requests.every(request => !request.path.endsWith('.zip')));
      const failureEvents = [];
      for (const [mode, detail] of [
        ['indexUnauthorized', 'api.github.com returned HTTP 401 while reading the Stable release listing.'],
        ['indexMissing', 'api.github.com returned HTTP 404 while reading the Stable release listing.'],
        ['indexUnavailable', 'api.github.com returned HTTP 503 while reading the Stable release listing.'],
        ['metadataUnavailable', 'release-assets.githubusercontent.com returned HTTP 503 while reading signed release metadata.'],
        ['invalidIndex', 'The Stable release listing is incomplete or invalid.'],
      ]) {
        channel.select(mode);
        await button.click();
        await expect(updates.getByText(detail, { exact: true })).toBeVisible({ timeout: 12_000 });
        await expect(updates.getByText(/synthetic private response body|token=synthetic/)).toHaveCount(0);
        if (mode === 'indexUnauthorized' && candidateTarget) {
          const id = await updates.getByRole('status').locator('code').textContent();
          assert.match(id, /^[0-9a-f-]{36}$/);
          failureEvents.push({ action: 'update-check', id, context: {
            stage: 'metadata', code: 'channelIndexHttp', http: { status: 401, endpoint: 'api.github.com' },
          } });
        }
      }
      channel.select('current');
      channel.delay();
      await button.click();
      await expect.poll(() => channel.waiting).toBe(true);
      await expect(updates.getByText('The Stable channel took too long to respond. Try again.', { exact: true })).toBeVisible({ timeout: 12_000 });
      channel.release();
      assert.ok(channel.requests.every(request => !request.path.endsWith('.zip')));
      discovery.metadataDiagnostics = {
        indexStatuses: [401, 404, 503], metadataCdnStatus: 503,
        timeoutDistinguished: true, invalidIndexDistinguished: true, responseDetailsExcluded: true,
      };
      channel.select('available');
      await button.click();
      const prepare = updates.getByRole('button', { name: `Install ${channel.nextVersion}` });
      const confirmation = window.getByRole('dialog', { name: `Install Forge ${channel.nextVersion}?` });
      const confirm = confirmation.getByRole('button', { name: 'Save backup and install' });
      const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true });
      await prepare.press('Enter');
      await expect(confirmation).toHaveAccessibleDescription(/save a ZIP backup of application settings/);
      await expect(cancel).toBeFocused();
      await window.keyboard.press('Shift+Tab');
      await expect(confirm).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(confirmation).toHaveCount(0);
      await expect(prepare).toBeFocused();
      const journalPath = path.join(installation, 'update-job.json');
      const packageRequests = () => channel.requests.filter(request => request.path.endsWith('.zip')).length;
      async function selectBackup(destination) {
        await app.evaluate(({ dialog }, selected) => {
          dialog.showSaveDialog = async () => selected ? { canceled: false, filePath: selected } : { canceled: true };
        }, destination);
        await prepare.click();
        await expect(confirmation).toBeVisible();
        await confirm.click();
      }
      await selectBackup(null);
      await expect(prepare).toBeFocused();
      discovery.keyboardConfirmationAndPickerCancelRestoredFocus = true;
      assert.equal(packageRequests(), 0);
      await assert.rejects(stat(journalPath), { code: 'ENOENT' });

      const rejectedMetadata = [
        ['changedCandidate', 'selectionChanged', 'The Stable candidate changed. Check for updates again.'],
      ];
      if (candidateTarget) rejectedMetadata.push(
        ['indexUnauthorized', 'channelIndexHttp', 'api.github.com returned HTTP 401 while reading the Stable release listing.', { status: 401, endpoint: 'api.github.com' }],
        ['indexMissing', 'channelIndexHttp', 'api.github.com returned HTTP 404 while reading the Stable release listing.', { status: 404, endpoint: 'api.github.com' }],
        ['metadataUnavailable', 'channelMetadataHttp', 'release-assets.githubusercontent.com returned HTTP 503 while reading signed release metadata.', { status: 503, endpoint: 'release-assets.githubusercontent.com' }],
        ['current', 'channelTimeout', 'The Stable channel took too long to respond. Try again.'],
      );
      for (const [mode, code, message, http] of rejectedMetadata) {
        channel.select(mode);
        if (code === 'channelTimeout') channel.delay();
        const destination = path.join(run, 'backup-preflight-' + mode + '.zip');
        await selectBackup(destination);
        const alert = updates.getByRole('alert');
        await expect(alert.getByText(message, { exact: true })).toBeVisible({ timeout: 12_000 });
        if (code === 'channelTimeout') channel.release();
        const id = await alert.locator('code').textContent();
        assert.match(id, /^[0-9a-f-]{36}$/);
        failureEvents.push({ action: 'update-stage', id, context: { stage: 'metadata', code, ...(http ? { http } : {}) } });
        await expect(prepare).toHaveCount(0);
        assert.equal(packageRequests(), 0);
        await assert.rejects(stat(destination), { code: 'ENOENT' });
        await assert.rejects(stat(journalPath), { code: 'ENOENT' });
        assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
        channel.select('available');
        await button.click();
        await expect(prepare).toBeEnabled();
      }
      discovery.metadataDiagnostics.refusedBeforeJobOrBackup = rejectedMetadata.map(([, code]) => code);

      const installedHelper = path.join(slot, 'forge-update-helper.exe');
      const installedEnv = { ...fresh, ...channel.env };
      assert.equal(JSON.parse(checked(installedHelper, ['check-updates'], {
        env: { ...installedEnv, FORGE_TEST_DISCOVERY_ORIGIN: 'https://127.0.0.1:1/' },
      })).state, 'offline');
      const { stdout: certificateFailure } = await execute(installedHelper, ['check-updates'], {
        env: { ...installedEnv, FORGE_TEST_DISCOVERY_CA: path.join(run, 'update-fixture-server.pem') },
        windowsHide: true, timeout: 12_000,
      });
      const untrustedTls = JSON.parse(certificateFailure);
      assert.equal(untrustedTls.code, 'channelTls');
      assert.match(untrustedTls.message, /^Forge could not verify the Stable channel connection/);
      discovery.metadataDiagnostics.rejectedUntrustedTls = true;
      const interruptedPath = path.join(run, 'backup-before-interruption.zip');
      const request = JSON.stringify({
        version: channel.nextVersion, packageSha256: channel.packageSha256, backupPath: interruptedPath,
      });
      channel.delayPackage();
      const interrupted = spawn(installedHelper, ['stage-update'], { env: installedEnv, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const stopped = once(interrupted, 'close');
      interrupted.stdin.end(request);
      try {
        await expect.poll(() => channel.packageWaiting).toBe(true);
        assert.equal(JSON.parse(checked(installedHelper, ['update-status'], { env: installedEnv })).lastJob.phase, 'downloading');
        reject(installedHelper, ['stage-update'], /operation may already be running/i, { env: installedEnv, input: request, timeout: 3_000 });
        assert.ok((await stat(interruptedPath)).size > 0);
      } finally {
        interrupted.kill();
        await stopped;
        if (channel.packageWaiting) channel.releasePackage();
      }
      assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
      await button.click();
      await expect(updates.getByText('Preparation interrupted')).toBeVisible();

      const requestsBeforeRetry = packageRequests();

      if (fullBackupVolume) {
        const capacity = await exhaustBackupVolume(fullBackupVolume);
        const destination = path.join(fullBackupVolume, 'update-backup.zip');
        await selectBackup(destination);
        await expect(updates.getByText('The backup volume has insufficient free space. Choose a different destination.')).toBeVisible();
        const refused = JSON.parse(await readFile(journalPath, 'utf8'));
        assert.equal(refused.phase, 'failed');
        assert.equal(refused.issue, 'backupStorageFull');
        assert.equal(refused.backup, null);
        assert.equal(packageRequests(), requestsBeforeRetry);
        assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
        await assert.rejects(stat(destination), { code: 'ENOENT' });
        discovery.backupStorageFull = {
          ...capacity, updatePreservedActiveVersion: true, archiveAndReceiptAbsent: true, noPackageDownloaded: true,
        };
      }

      const occupied = path.join(run, 'occupied.zip');
      await writeFile(occupied, 'keep this file');
      await selectBackup(occupied);
      await expect(updates.getByText('The backup name already exists. Choose a new ZIP file.')).toBeVisible();
      assert.equal(await readFile(occupied, 'utf8'), 'keep this file');
      assert.equal(packageRequests(), requestsBeforeRetry);
      assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);

      channel.select('badArchive');
      await selectBackup(path.join(run, 'backup-before-corrupt-download.zip'));
      await expect(updates.getByText('The update package failed integrity or package identity verification.')).toBeVisible({ timeout: 60_000 });
      assert.equal(packageRequests(), requestsBeforeRetry + 1);
      assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
      assert.deepEqual(await readdir(path.join(installation, 'slots')), [active.slot]);

      channel.select('available');
      const cdnAttempts = () => channel.requests.filter(request => request.path === '/forge-qualification/archive');
      if (candidateTarget) {
        const permanentFailure = 'release-assets.githubusercontent.com returned HTTP 503 while downloading the update package.';
        for (const [caseName, responses, attemptCount] of [
          ['over-budget', [{ status: 503, retryAfter: '600' }], 1],
          ['exhausted', Array.from({ length: 3 }, () => ({ status: 503, retryAfter: '0' })), 3],
        ]) {
          const before = cdnAttempts().length;
          channel.retryPackage(responses);
          const destination = path.join(run, 'backup-' + caseName + '.zip');
          await selectBackup(destination);
          await expect(updates.getByText(permanentFailure, { exact: true })).toBeVisible({ timeout: 20_000 });
          assert.equal(cdnAttempts().length - before, attemptCount);
          assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
          const failedJob = JSON.parse(await readFile(journalPath, 'utf8'));
          assert.equal(failedJob.phase, 'failed');
          assert.deepEqual(failedJob.downloadHttpError, { status: 503, endpoint: 'release-assets.githubusercontent.com' });
          const failureStatus = JSON.parse(checked(installedHelper, ['update-status'], { env: installedEnv })).lastJob;
          assert.equal(failureStatus.message, permanentFailure);
          assert.deepEqual(failureStatus.downloadHttpError, failedJob.downloadHttpError);
          failureEvents.push({ action: 'update-stage', id: failedJob.id, context: {
            stage: 'download', code: 'packageHttp', http: failedJob.downloadHttpError,
          } });
          assert.equal(JSON.stringify(failedJob).includes('token=synthetic'), false);
          assert.ok((await stat(destination)).size > 0);
          assert.ok(!(await readdir(installation)).some(name => name.endsWith('.zip.part')));
          await expect(prepare).toBeEnabled();
          await button.click();
          await expect(prepare).toBeEnabled();
        }
        const priorJob = await readFile(journalPath);
        const priorRequests = packageRequests();
        const refusedBackup = path.join(run, 'backup-preflight-after-download-failure.zip');
        channel.select('indexUnauthorized');
        await selectBackup(refusedBackup);
        await expect(updates.getByRole('alert').getByText('api.github.com returned HTTP 401 while reading the Stable release listing.', { exact: true })).toBeVisible();
        assert.deepEqual(await readFile(journalPath), priorJob);
        assert.equal(packageRequests(), priorRequests);
        await assert.rejects(stat(refusedBackup), { code: 'ENOENT' });
        discovery.metadataDiagnostics.preservedPreviousJobAfterFailedRecheck = true;
        channel.select('available');
        await button.click();
        await expect(prepare).toBeEnabled();
        channel.retryPackage([{ status: 503, retryAfter: '1' }, { status: 502, retryAfter: '0' }]);
      }
      const preActivationCdnAttempts = cdnAttempts().length;
      const backup = path.join(run, 'backup-before-verified-download.zip');
      const database = path.join(project, '.forge', 'workspace.sqlite');
      const originalProject = await fileDigest(database);
      const originalSettings = manualRollback ? await settingsIn(window) : undefined;
      const sourceExited = once(originalProcess, 'exit');
      await selectBackup(backup);
      const candidateWait = slowReadiness
        ? await observeDelayedReadiness(journalPath, 'starting', channel.nextVersion, candidateDelayMs, active)
        : undefined;
      if (interruptedStartup) {
        await sourceExited;
        await expect.poll(async () => JSON.parse(await readFile(journalPath, 'utf8')).phase, { timeout: 60_000 }).toBe('starting');
        const { candidate: waiting } = JSON.parse(await readFile(journalPath, 'utf8'));
        await expect.poll(() => isFixtureSlotRunning(waiting), { timeout: 10_000 }).toBe(true);
        assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), active);
        assert.match(stopFixtureLauncher(), /^[1-9]\d*$/);
        await expect.poll(() => isFixtureSlotRunning(waiting), { timeout: 10_000 }).toBe(false);
        const recovered = spawn(installedLauncher, [], { env: installedEnv, stdio: 'ignore', windowsHide: true });
        assert.deepEqual(await once(recovered, 'exit', { signal: AbortSignal.timeout(70_000) }), [0, null]);
      }
      const expectedPhase = failedStartup || interruptedStartup ? 'rolledBack' : 'healthy';
      await expect.poll(async () => JSON.parse(await readFile(journalPath, 'utf8')).phase, {
        timeout: 100_000, message: `Installer should finish with ${expectedPhase}`,
      }).toMatch(/^(healthy|rolledBack|recoveryRequired)$/);
      await sourceExited;
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      assert.equal(journal.phase, expectedPhase, JSON.stringify({ issue: journal.issue, recoveryIssue: journal.recoveryIssue }));
      const readiness = candidateWait && completedDelayedReadiness(candidateWait, journal.phase);
      if (candidateTarget) {
        const [first, second, third, ...unexpected] = cdnAttempts().slice(preActivationCdnAttempts);
        assert.ok(first && second && third);
        assert.equal(unexpected.length, 0);
        const retryAfterDelayMs = Math.round(second.receivedAt - first.receivedAt);
        assert.ok(retryAfterDelayMs >= 980, 'Retry-After must delay the next package GET');
        assert.equal(journal.downloadHttpError, undefined);
        discovery.packageRetries = {
          successfulAttempts: 3, retryAfterDelayMs, exhaustedAfterAttempts: 3,
          overBudgetStoppedAfterAttempts: 1, retainedPreviousSlotOnFailure: true,
          persistedSafeStatusAndSource: true, incompletePackageRemoved: true,
        };
      }
      const staged = path.join(installation, 'slots', journal.candidate.slot);
      const current = expectedPhase === 'rolledBack' ? active : journal.candidate;
      assert.deepEqual(JSON.parse(await readFile(activePath, 'utf8')), current);
      await expect.poll(() => visibleSlot(current), { timeout: 15_000 }).toBe(true);
      assert.equal(await fileDigest(database), originalProject);
      assert.equal(journal.targetVersion, channel.nextVersion);
      assert.deepEqual(journal.previous, active);
      assert.equal(journal.backup.info.archiveSha256, await fileDigest(backup));
      assert.ok(!JSON.stringify(journal).includes(path.basename(backup)));
      assert.equal(JSON.parse(await readFile(path.join(staged, 'resources/app/package.json'), 'utf8')).version, channel.nextVersion);
      const activeHelper = path.join(installation, 'slots', current.slot, 'forge-update-helper.exe');
      const after = JSON.parse(checked(activeHelper, ['update-status'], { env: installedEnv }));
      assert.equal(after.installedVersion, current.version);
      assert.equal(after.lastJob.phase, expectedPhase);
      if (candidateTarget) {
        assert.equal(current.version, workspaceVersion);
        assert.equal(current.packageSha256, await fileDigest(archive));
        const exactFiles = [
          'Forge.exe', 'forge-update-helper.exe', 'resources/bin/forge-core.exe',
          'resources/app/package.json', 'resources/app/dist/index.html',
          'notices/git/git2-0.21.0-Apache-2.0.txt', 'notices/git/git2-0.21.0-MIT.txt',
          'notices/git/libgit2-1.9.7-COPYING.txt', 'notices/git/libz-sys-1.1.33-zlib.txt',
          '.forge-install-manifest.json', '.forge-install-manifest.sig',
        ];
        for (const relative of exactFiles) {
          assert.equal(await fileDigest(path.join(staged, relative)), await fileDigest(path.join(referenceSlot, relative)), relative);
        }
        const sourceHelper = await fileDigest(installedHelper);
        const targetHelper = await fileDigest(activeHelper);
        assert.notEqual(sourceHelper, targetHelper);
        discovery.candidateAsUpdateTarget = {
          predecessorVersion: active.version, predecessorSha256: active.packageSha256,
          version: current.version, packageSha256: current.packageSha256, exactExtractedFiles: exactFiles,
          independentlyBuiltPredecessor: true, separateHelperCompatibilityVersion: manifest.compatibility.helperMin,
          productionUpdaterFeatureSetBuilt: true, firstInstallAndUpdateUsedSameArchiveAndSignature: true,
        };
      }
      if (failedStartup) assert.equal(journal.issue, 'candidateHealth');
      if (interruptedStartup) assert.equal(journal.issue, 'activationInterrupted');
      assert.ok((await readdir(installation)).every(file => !file.endsWith('.part')));
      assert.equal(packageRequests(), requestsBeforeRetry + 1 + (candidateTarget ? cdnAttempts().length : 1));
      await channel.close();
      discovery.loopbackUpdates = {
        pinnedFixtureCertificate: true, checkingAndUpToDate: true, newerSignedNotes: true, incompatible: true,
        corruptSignatureAndDifferentSameVersionDigest: true, blockedForeignRedirect: true, offlineAndEmpty: true,
        wrongSignedChannelRejected: true, freshRequests: true, startupLocalOnly: true, noPackageDownloaded: true,
      };
      discovery.staging = {
        nextVersion: channel.nextVersion, packageSha256: journal.targetSha256,
        preservesActivePointerOnPreparationFailure: true, noInstalledRuntimeReplacement: true, cancellationDoesNotDownload: true,
        occupiedDestinationPreserved: true, corruptZipRejected: true, savedBackupDigestVerified: true,
        staleSelectionRejected: true, simultaneousPreparationRejected: true, interruptedDownloadRecoveredOnRetry: true,
        durablyStagedFromSettings: true, fixtureReusesNativeBinaries: !candidateTarget,
      };
      discovery.activation = {
        phase: expectedPhase, activeVersion: after.installedVersion, startupFailureInjected: failedStartup,
        ...(readiness && { readiness, qualificationPackageSha256: journal.targetSha256 }),
        supervisorInterruptionInjected: interruptedStartup,
        verifiedHealthHandshake: true, correctVersionHasVisibleWindow: true, originalProjectSha256: originalProject,
        projectDatabaseUnchanged: true, sameSavedZipVerified: true,
      };
      if (manualRollback) discovery.manualRollback = await exerciseManualRollback({
        current, env: installedEnv, originalSettings, backup, database, projectSha: originalProject, journalPath, video, failureEvents,
      });
    } else if (liveDiscovery) {
      await button.click();
      await expect(updates.getByText('The Stable channel has no published immutable Forge release.')).toBeVisible();
      discovery.liveStableChannel = { state: 'no published immutable Forge release', testOverrideIgnored: true };
    }
  }
  const evidence = {
    outcome: 'PASS', platform: 'windows-x64', channel: 'test signing key', version: workspaceVersion, delivery,
    candidateCommit: testCommit, candidateCommitIsFixture: !committed,
    packageBytes: manifest.artifact.bytes, packageSha256: manifest.artifact.sha256,
    setupSha256: await fileDigest(bootstrap), signedManifestSha256: await fileDigest(signedPath),
    verifiedBeforeInstall: true, wrongSignaturePlatformChannelURLTagSizeAndCompatibilityRejected: true,
    packageDigestAndEmbeddedCommitRejected: true, existingInstallPreserved: true, rotationHandOffVerified: true,
    launchedExactSlotAndCreatedLocalProject: true, runtime: check.electron, offNetwork: true,
    ...(interruptedInstall ? { interruptedFirstInstall: { retriedSameSignedPackage: true, abandonedSlotRemoved: true } } : {}),
    ...discovery,
  };
  await writeFile(path.join(run, 'observations.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (candidate) {
    await writeFile(path.join(delivery, 'forge-release.unsigned.json'), canonical(manifest), { flag: 'wx' });
    await writeFile(path.join(delivery, 'forge-package-smoke.json'), canonical(evidence), { flag: 'wx' });
  }
  console.log('Windows test-signed first installation PASS. Evidence: ' + run);
} finally {
  await channel?.close();
  if (originalProcess?.exitCode === null && originalProcess.signalCode === null) await app.close();
  if (channel) closeFixtureWindows();
}

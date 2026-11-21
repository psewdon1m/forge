import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const command = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'settings-backup-ui-'));
const archive = path.join(run, 'preferences-off.zip');
const alternate = path.join(run, 'preferences-on.zip');
const corrupt = path.join(run, 'truncated.zip');
const project = path.join(run, 'Target workspace');
await mkdir(project);

async function launch(profile) {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile) },
  });
  await app.evaluate(({ dialog }, paths) => {
    globalThis.archivePick = paths.archive;
    globalThis.restoreResponse = 0;
    dialog.showSaveDialog = async (_window, options) => {
      if (!options.defaultPath.startsWith('Forge-settings-')) throw new Error('Expected a settings archive picker');
      return { canceled: false, filePath: globalThis.archivePick };
    };
    dialog.showOpenDialog = async (_window, options) => {
      const file = options.properties.includes('openFile') ? globalThis.archivePick : paths.project;
      return { canceled: false, filePaths: [file] };
    };
    dialog.showMessageBox = async (_window, options) => {
      if (options.defaultId !== 0 || options.cancelId !== 0 || options.buttons[0] !== 'Cancel') {
        throw new Error('Settings restore must default to cancellation');
      }
      return { response: globalThis.restoreResponse };
    };
  }, { archive, project });
  return app;
}

function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}

const enter = (page, name) => page.getByRole('button', { name, exact: true }).click();
const snapButton = page => page.getByRole('button', { name: 'Snap to grid', exact: true });
const readSettings = async page => value(await page.evaluate(() => window.forge.project.readSettings()));
const select = (app, file) => app.evaluate((_, file) => { globalThis.archivePick = file; }, file);
const inspectButton = page => page.getByRole('button', { name: 'Inspect settings archive' });
const restoreButton = page => page.getByRole('button', { name: 'Restore settings', exact: true });

let app = await launch('Source profile');
try {
  const page = await app.firstWindow();
  await expect(snapButton(page)).toBeEnabled();
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'true');
  await snapButton(page).click();
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'false');
  await enter(page, 'Settings');
  await enter(page, 'Export settings');
  await expect(page.getByRole('status').filter({ hasText: 'Settings archive saved as preferences-off.zip.' })).toBeVisible();

  await enter(page, 'Space');
  await snapButton(page).click();
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'true');
  await select(app, alternate);
  await enter(page, 'Settings');
  await enter(page, 'Export settings');
  await expect(page.getByRole('status').filter({ hasText: 'Settings archive saved as preferences-on.zip.' })).toBeVisible();
  await enter(page, 'Space');
  await snapButton(page).click();
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'false');
} finally {
  await app.close();
}

const saved = await readFile(archive);
const archiveSha256 = createHash('sha256').update(saved).digest('hex');
await writeFile(corrupt, saved.subarray(0, -12));
const members = (await command('tar.exe', ['-tf', archive])).stdout.trim().split(/\r?\n/);
assert.deepEqual(members, ['data/settings.json', 'manifest.json']);
const manifest = JSON.parse((await command('tar.exe', ['-xOf', archive, 'manifest.json'])).stdout);
assert.equal(manifest.scope, 'settings');
assert.equal(manifest.restoreMode, 'replace');
const archived = JSON.parse((await command('tar.exe', ['-xOf', archive, 'data/settings.json'])).stdout);
assert.deepEqual(archived, { schemaVersion: 1, preferences: { snapToGrid: false } });

app = await launch('Source profile');
try {
  const page = await app.firstWindow();
  await expect(snapButton(page)).toBeEnabled();
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'false');
} finally {
  await app.close();
}

app = await launch('Destination profile');
let revision;
try {
  const page = await app.firstWindow();
  await expect(snapButton(page)).toBeEnabled();
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'true');
  const initial = await readSettings(page);
  await enter(page, 'Projects');
  await page.getByLabel('Project name').fill('Active project during settings restore');
  await enter(page, 'Create project');
  await expect(page.getByRole('heading', { name: 'Active project during settings restore' })).toBeVisible();
  const before = value(await page.evaluate(() => window.forge.project.view()));
  await enter(page, 'Settings');
  await select(app, corrupt);
  await inspectButton(page).click();
  await expect(page.getByRole('alert')).toContainText('ZIP');
  await expect(restoreButton(page)).toHaveCount(0);
  assert.deepEqual(await readSettings(page), initial);

  await select(app, archive);
  await inspectButton(page).click();
  await expect(page.getByText('Settings schema 1 · Snap to grid off')).toBeVisible();
  await restoreButton(page).click();
  await expect(restoreButton(page)).toBeEnabled();
  assert.deepEqual(await readSettings(page), initial);

  await app.evaluate(() => { globalThis.restoreResponse = 1; });
  await copyFile(alternate, archive);
  await restoreButton(page).click();
  await expect(page.getByRole('alert')).toContainText('differs from the inspected file');
  assert.deepEqual(await readSettings(page), initial);
  await writeFile(archive, saved);

  await inspectButton(page).click();
  await expect(restoreButton(page)).toBeEnabled();
  const advanced = value(await page.evaluate(baseRevision => window.forge.project.saveSettings({
    baseRevision, snapToGrid: true,
  }), initial.revision));
  await restoreButton(page).click();
  await expect(page.getByRole('alert')).toContainText('settings changed');
  assert.deepEqual(await readSettings(page), advanced);

  await inspectButton(page).click();
  await expect(restoreButton(page)).toBeEnabled();
  await restoreButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Application settings restored.' })).toBeVisible();
  const applied = await readSettings(page);
  assert.equal(applied.preferences.snapToGrid, false);
  assert.equal(applied.revision, advanced.revision + 1);
  revision = applied.revision;
  assert.deepEqual(value(await page.evaluate(() => window.forge.project.view())), before);
  await enter(page, 'Space');
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'false');
} finally {
  await app.close();
}

app = await launch('Destination profile');
try {
  const page = await app.firstWindow();
  await expect(snapButton(page)).toBeEnabled();
  await expect(snapButton(page)).toHaveAttribute('aria-pressed', 'false');
  assert.equal((await readSettings(page)).revision, revision);
} finally {
  await app.close();
}

console.log(JSON.stringify({
  outcome: 'PASS', run, archiveSha256, bytes: saved.length, members,
  portableAcrossProfiles: true, corruptRejected: true, confirmedReplaceWithoutProjectChange: true,
  restoreDefaultedToCancel: true, changedArchiveRejected: true, staleSettingsRejected: true,
  sourcePersisted: true, restorationPersisted: true,
}, null, 2));

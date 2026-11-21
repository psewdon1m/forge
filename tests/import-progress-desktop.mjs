import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'import-progress-'));
const project = path.join(run, 'Project');
await mkdir(project);
const kept = path.join(run, 'kept.txt');
const small = path.join(run, 'small.txt');
const large = path.join(run, 'large-1.txt');
await Promise.all([writeFile(kept, 'Original version'), writeFile(small, 'Retry this file')]);
const largeFile = await open(large, 'wx');
try {
  const block = Buffer.alloc(1024 * 1024, 0x61);
  for (let index = 0; index < 127; index++) assert.equal((await largeFile.write(block)).bytesWritten, block.length);
} finally {
  await largeFile.close();
}
const copies = [2, 3, 4].map(index => path.join(run, 'large-' + index + '.txt'));
await Promise.all(copies.map(file => link(large, file)));

const app = await _electron.launch({
  executablePath, args: [root],
  env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, 'Profile') },
});
try {
  await app.evaluate(({ dialog }, fixture) => {
    globalThis.nextImport = [fixture.kept];
    dialog.showOpenDialog = async (_window, options) => ({
      canceled: false,
      filePaths: options.properties.includes('openDirectory') ? [fixture.project] : globalThis.nextImport,
    });
  }, { project, kept });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Import progress fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  const importButton = page.getByRole('button', { name: 'Import files', exact: true });
  await importButton.click();
  await expect(page.getByText('Imported 1 of 1 files')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss import results' }).click();
  const baseline = (await page.evaluate(() => window.forge.project.view())).value;
  assert.equal(baseline.revision, 1);
  const original = baseline.space.nodes[0].content.asset;
  const originalFile = path.join(project, 'assets', 'asset-' + original.versionId + '.txt');
  await app.evaluate((_electron, files) => { globalThis.nextImport = files; }, [small, large, ...copies]);
  const progress = page.getByRole('region', { name: 'Import progress' });
  // Hidden qualification windows can suppress animation-frame polling. Observe
  // the live progress panel, read the Projects dashboard and use its Cancel button.
  await page.evaluate(() => {
    const observer = new MutationObserver(async () => {
      const panel = document.querySelector('[aria-label="Import progress"]');
      const bar = panel?.querySelector('progress');
      const button = [...(panel?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Cancel import');
      if (!bar || bar.value <= 0 || bar.value >= bar.max || bar.max < 100_000_000 || !button || button.disabled) return;
      observer.disconnect();
      const progress = { bytes: bar.value, total: bar.max };
      const start = performance.now();
      try {
        const recent = await window.forge.project.recent();
        globalThis.canceledAfterCopy = {
          ...progress, dashboardQueryMs: Math.round(performance.now() - start),
          projectListed: recent.ok && recent.value.some(project => project.title === 'Import progress fixture'),
          copyingWhenDashboardReplied: button.isConnected && !button.disabled,
        };
      } catch (error) {
        globalThis.canceledAfterCopy = { ...progress, dashboardError: String(error) };
      } finally {
        button.click();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['value', 'max'] });
  });
  await importButton.click();
  const observed = await (await page.waitForFunction(() => globalThis.canceledAfterCopy, undefined, { polling: 10 })).jsonValue();
  assert.equal(observed.projectListed, true, JSON.stringify(observed));
  assert.equal(observed.copyingWhenDashboardReplied, true, JSON.stringify(observed));
  await expect(page.getByText('Import canceled', { exact: true })).toBeVisible();
  await expect(progress).toHaveCount(0);
  assert.deepEqual((await page.evaluate(() => window.forge.project.view())).value.space, baseline.space);
  assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 1);
  assert.deepEqual(await readdir(path.join(project, 'assets')), [path.basename(originalFile)]);
  assert.deepEqual(await readFile(originalFile), await readFile(kept));
  assert.deepEqual(await readdir(path.join(project, '.forge', 'staging')), []);
  const db = new DatabaseSync(path.join(project, '.forge', 'workspace.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) as count FROM asset_intents').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) as count FROM asset_versions').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) as count FROM asset_import_batches').get().count, 1);
  } finally {
    db.close();
  }
  await app.evaluate((_electron, file) => { globalThis.nextImport = [file]; }, small);
  await importButton.click();
  await expect(page.getByText('Imported 1 of 1 files')).toBeVisible();
  assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 2);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, observed, inputBatchBytes: observed.total * (copies.length + 1) + Buffer.byteLength('Retry this file'),
    actualUiCancel: true, unchangedRevision: 1, successfulRetryRevision: 2,
    acceptedPrefixRolledBack: true, stagingAndLedgerEmpty: true, committedBytesUnchanged: true,
  }, null, 2) + '\n');
  console.log('Import progress and cancellation in Windows UI PASS. Evidence: ' + run);
} finally {
  await app.close();
  await Promise.all([large, ...copies].map(file => unlink(file)));
}

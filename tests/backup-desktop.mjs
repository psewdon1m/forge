import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'backup-ui-'));
const source = path.join(run, 'Source');
const archive = path.join(run, 'fixture.zip');
const damaged = path.join(run, 'damaged.zip');
await mkdir(source);

async function launch(profile) {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile) },
  });
  await app.evaluate(({ dialog }, paths) => {
    const { source, archive, run } = paths;
    globalThis.backupPicker = archive;
    globalThis.archiveResponse = 0;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: archive });
    dialog.showOpenDialog = async (_owner, request) => ({ canceled: false, filePaths: [
      request.title.startsWith('Choose a parent') ? run : request.properties.includes('openFile') ? globalThis.backupPicker : source,
    ] });
    dialog.showMessageBox = async (_owner, request) => {
      if (request.defaultId !== 0 || request.cancelId !== 0 || request.buttons[0] !== 'Cancel') {
        throw new Error('Archive project must default to cancellation');
      }
      return { response: globalThis.archiveResponse };
    };
  }, { source, archive, run });
  return app;
}

const value = reply => {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
};
let original;
let originalHistory;
let app = await launch('Source profile');
const quote = 'Keep this explicit quote in the recovery fixture.';
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Backup test project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Backup test project' })).toBeVisible();
  const initial = value(await page.evaluate(() => window.forge.project.view()));
  await mkdir(path.join(source, 'Working', 'Empty'), { recursive: true });
  await writeFile(path.join(source, 'Working', 'brief.txt'), quote);
  await writeFile(path.join(source, '.env'), 'SYNTHETIC_TEST_SECRET=backup-test');
  const api = args => page.evaluate(async ([method, input]) => window.forge.project[method](input), args);
  const note = {
    id: randomUUID(), label: 'Quote', position: { x: 10, y: 20 }, content: { kind: 'note', text: quote },
  };
  value(await api(['apply', {
    projectId: initial.space.projectId, baseRevision: 0, operationId: randomUUID(), change: { kind: 'add', node: note },
  }]));
  value(await api(['saveViewport', { projectId: initial.space.projectId, viewport: { x: 5, y: 12, zoom: 1.2 } }]));
  // Reopen so the renderer adopts the revision written through IPC.
  await app.close();
  app = await launch('Source profile');
  const reopened = await app.firstWindow();
  await reopened.getByRole('button', { name: 'Projects', exact: true }).click();
  await reopened.getByRole('button', { name: 'Backup test project' }).click();
  await expect(reopened.getByRole('heading', { name: 'Backup test project' })).toBeVisible();
  original = value(await reopened.evaluate(() => window.forge.project.view()));
  originalHistory = value(await reopened.evaluate(() => window.forge.project.history()));
  await reopened.getByRole('button', { name: 'Settings', exact: true }).click();
  await reopened.getByRole('button', { name: 'Export project' }).click();
  await expect(reopened.getByRole('status').filter({ hasText: 'Exported and verified revision 1' })).toBeVisible();
  await reopened.getByRole('button', { name: 'Projects', exact: true }).click();
  const cancel = value(await reopened.evaluate(id => window.forge.project.archive(id), original.space.projectId));
  assert.equal(cancel, false);
  await expect(reopened.getByRole('button', { name: 'Backup test project' })).toBeVisible();
  await app.evaluate(() => { globalThis.archiveResponse = 1; });
  await reopened.getByRole('button', { name: 'Archive project' }).click();
  await expect(reopened.getByRole('alert')).toHaveText('Project archived. Use Open project to reopen its folder.');
  await expect(reopened.getByRole('button', { name: 'Backup test project' })).toHaveCount(0);
  assert.deepEqual(value(await reopened.evaluate(() => window.forge.project.recent())), []);
  assert.equal((await reopened.evaluate(() => window.forge.project.view())).ok, false);
  await app.close();
  app = await launch('Source profile');
  const archivedPage = await app.firstWindow();
  await archivedPage.getByRole('button', { name: 'Projects', exact: true }).click();
  assert.deepEqual(value(await archivedPage.evaluate(() => window.forge.project.recent())), []);
  await archivedPage.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(archivedPage.getByRole('heading', { name: 'Backup test project' })).toBeVisible();
  assert.deepEqual(value(await archivedPage.evaluate(() => window.forge.project.view())), original);
} finally {
  await app.close();
}

const bytes = await readFile(archive);
const archiveSha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(bytes.includes(Buffer.from('SYNTHETIC_TEST_SECRET')), false);
await writeFile(damaged, bytes.subarray(0, -12));
app = await launch('Clean profile');
let restored;
let restoredFolder;
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export project' })).toBeDisabled();
  await app.evaluate((_, file) => { globalThis.backupPicker = file; }, damaged);
  await page.getByRole('button', { name: 'Inspect archive' }).click();
  await expect(page.getByRole('alert')).toContainText('ZIP');
  await expect(page.getByRole('button', { name: 'Restore as copy' })).toHaveCount(0);
  await app.evaluate((_, file) => { globalThis.backupPicker = file; }, archive);
  await page.getByRole('button', { name: 'Inspect archive' }).click();
  await expect(page.getByText('Revision 1 · 1 files · 2 revisions · 0 analyses')).toBeVisible();
  await page.getByRole('button', { name: 'Restore as copy' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Open the copy from Projects.' })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Backup test project' }).click();
  await expect(page.getByRole('heading', { name: 'Backup test project' })).toBeVisible();
  restored = value(await page.evaluate(() => window.forge.project.view()));
  assert.notEqual(restored.space.projectId, original.space.projectId);
  assert.deepEqual({ ...restored, space: { ...restored.space, projectId: original.space.projectId } }, original);
  const history = value(await page.evaluate(() => window.forge.project.history()));
  const withoutDigest = ({ digest: _digest, ...revision }) => revision;
  assert.deepEqual(history.map(withoutDigest), originalHistory.map(withoutDigest));
  restoredFolder = (await readdir(run)).find(name => name.startsWith('Forge restored '));
  assert.equal(await readFile(path.join(run, restoredFolder, 'Working', 'brief.txt'), 'utf8'), quote);
  assert.deepEqual(await readdir(path.join(run, restoredFolder, 'Working', 'Empty')), []);
  const manifest = JSON.parse(await readFile(path.join(run, restoredFolder, '.forge', 'project.json'), 'utf8'));
  assert.equal(manifest.sourceProjectId, original.space.projectId);
  await assert.rejects(readFile(path.join(run, restoredFolder, '.env')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(source, 'Working', 'brief.txt'), 'utf8'), quote);
} finally {
  await app.close();
}
console.log(JSON.stringify({ outcome: 'PASS', run, archive, archiveSha256, restoredFolder, sourceProjectId: original.space.projectId, restoredProjectId: restored.space.projectId, revision: original.revision, originalPreserved: true, restoredInCleanProfile: true, corruptArchiveRejected: true, secretExcluded: true, archiveConfirmationAndReopen: true }, null, 2));

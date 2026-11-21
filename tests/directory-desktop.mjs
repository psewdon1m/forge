import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'directory-ui-'));
const directory = path.join(run, 'Project');
await mkdir(directory);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, 'Profile') },
  });
  await app.evaluate(({ dialog }, directory) => {
    globalThis.directoryFixture = { response: 0, confirmations: [] };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    dialog.showMessageBox = async (_owner, info) => {
      if (info.defaultId !== 0 || info.cancelId !== 0 || info.buttons[0] !== 'Cancel') {
        throw new Error('Directory delete must default to cancellation');
      }
      globalThis.directoryFixture.confirmations.push(info.message);
      return { response: globalThis.directoryFixture.response };
    };
  }, directory);
  return app;
}

let app = await launch();
try {
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Directory fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Directory fixture' })).toBeVisible();
  await writeFile(path.join(directory, 'draft.txt'), 'Original sample');
  await page.getByRole('button', { name: 'Add Directory', exact: true }).click();
  await expect(page.getByText('1 objects · 0 links')).toBeVisible();
  const snapshot = (await page.evaluate(() => window.forge.project.view())).value;
  assert.equal(snapshot.revision, 1);
  const node = snapshot.space.nodes[0];
  assert.equal(node.content.typeId, 'forge.directory');
  const region = () => page.getByRole('region', { name: 'Project Directory' });
  const card = () => page.locator('.react-flow__node[data-id="' + node.id + '"]');
  await card().dblclick();
  await expect(region().getByRole('cell', { name: 'draft.txt', exact: true })).toBeVisible();
  await expect(region().getByText('.forge', { exact: true })).toHaveCount(0);
  await region().getByRole('button', { name: 'New folder', exact: true }).click();
  await region().getByLabel('Folder name').fill('Briefs');
  await region().getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(region().getByText('Folder created')).toBeVisible();
  await expect(region().getByRole('button', { name: 'Briefs', exact: true })).toBeVisible();

  await region().getByRole('button', { name: 'Rename draft.txt', exact: true }).click();
  await region().getByLabel('New name').fill('revised.txt');
  await writeFile(path.join(directory, 'draft.txt'), 'External sample');
  await region().getByRole('button', { name: 'Save name' }).click();
  await expect(region().getByRole('alert')).toHaveText('This entry changed. Refresh Directory and try again');
  assert.equal(await readFile(path.join(directory, 'draft.txt'), 'utf8'), 'External sample');
  await region().getByRole('button', { name: 'Cancel', exact: true }).click();
  await region().getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await region().getByRole('button', { name: 'Rename draft.txt', exact: true }).click();
  await region().getByLabel('New name').fill('revised.txt');
  await region().getByRole('button', { name: 'Save name' }).click();
  await expect(region().getByText('Entry renamed')).toBeVisible();
  await region().getByRole('button', { name: 'Move revised.txt', exact: true }).click();
  await expect(region().getByRole('button', { name: 'Move here' })).toBeDisabled();
  await region().getByRole('button', { name: 'Briefs', exact: true }).click();
  await region().getByRole('button', { name: 'Move here' }).click();
  await expect(region().getByText('Entry moved')).toBeVisible();
  const moved = path.join(directory, 'Briefs', 'revised.txt');
  assert.equal(await readFile(moved, 'utf8'), 'External sample');
  await region().getByRole('button', { name: 'Delete revised.txt', exact: true }).click();
  await expect(region().getByText('Delete canceled')).toBeVisible();
  assert.equal(await readFile(moved, 'utf8'), 'External sample');
  await app.evaluate(() => { globalThis.directoryFixture.response = 1; });
  await region().getByRole('button', { name: 'Delete revised.txt', exact: true }).click();
  await expect(region().getByText('Entry deleted')).toBeVisible();
  assert.deepEqual(await readdir(path.join(directory, 'Briefs')), []);
  assert.deepEqual(await app.evaluate(() => globalThis.directoryFixture.confirmations), ['Delete revised.txt?', 'Delete revised.txt?']);

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Directory fixture' }).click();
  await card().dblclick();
  await expect(region().getByRole('button', { name: 'Briefs', exact: true })).toBeVisible();
  const confirmed = (await page.evaluate(() => window.forge.project.view())).value;
  assert.equal(confirmed.revision, 1);
  assert.equal(confirmed.space.nodes[0].id, node.id);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, directoryPortalFromSpace: true, projectStorageHidden: true,
    folderAndBreadcrumbs: true, staleRenameRejected: true, createRenameAndMove: true,
    deleteCancelAndConfirmation: true, reopenedSameDirectoryPortal: true, projectRevisionRemains: confirmed.revision,
  }, null, 2) + '\n');
  console.log('Directory desktop PASS. Evidence: ' + run);
} finally {
  await app.close();
}

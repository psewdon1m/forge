import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'directory-source-'));
const project = path.join(run, 'Project');
const profile = path.join(run, 'Profile');
const outside = path.join(run, 'Outside');
await Promise.all([mkdir(project), mkdir(outside)]);
const digest = value => createHash('sha256').update(value).digest('hex');

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
  });
  await app.evaluate(({ BrowserWindow, dialog }, directory) => {
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, project);
  return app;
}

let app = await launch();
try {
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Directory sources qualification');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByText('0 objects · 0 links')).toBeVisible();
  const tiles = Array.from({ length: 25 }, (_, i) => 'item-' + String(i + 1).padStart(2, '0') + '.txt');
  const nested = path.join(project, 'materials');
  const storage = path.join(project, 'assets');
  await Promise.all([mkdir(nested), mkdir(storage, { recursive: true })]);
  const exterior = path.join(outside, 'outside.txt');
  const secret = 'Contents outside the project.';
  await writeFile(exterior, secret);
  await Promise.all([
    symlink(outside, path.join(project, 'outside-folder'), 'junction'),
    link(exterior, path.join(project, 'linked-text.txt')),
    writeFile(path.join(storage, 'hidden.txt'), 'protected store'),
    writeFile(path.join(project, 'begin.txt'), 'alpha\n'),
    writeFile(path.join(project, 'unknown.bin'), Buffer.from([1, 2, 3])),
    writeFile(path.join(project, 'invalid.png'), 'not an image'),
    writeFile(path.join(nested, 'z-edited.md'), 'beta\n'),
    ...tiles.map(name => writeFile(path.join(nested, name), 'a row for paging\n')),
  ]);
  const fixedTime = new Date('2024-01-10T12:00:00Z');
  await utimes(path.join(project, 'begin.txt'), fixedTime, fixedTime);
  const pixel = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 23;
    canvas.height = 14;
    const context = canvas.getContext('2d');
    context.fillStyle = '#cc1212';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const red = canvas.toDataURL().split(',')[1];
    context.fillStyle = '#2156cb';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return [red, canvas.toDataURL().split(',')[1]];
  });
  await Promise.all([
    writeFile(path.join(project, 'left.png'), Buffer.from(pixel[0], 'base64')),
    writeFile(path.join(project, 'right.png'), Buffer.from(pixel[1], 'base64')),
  ]);

  const view = () => page.evaluate(() => window.forge.project.view()).then(reply => reply.value);
  const card = id => page.locator('.react-flow__node[data-id="' + id + '"]');
  const back = () => page.getByRole('button', { name: 'Back to Space', exact: true }).click();
  const metadata = () => page.getByRole('region', { name: 'Metadata analysis' });
  const compare = () => page.getByRole('region', { name: 'Comparison analysis' });
  const api = (key, request) => page.evaluate(({ key, request }) => window.forge.project[key](request), { key, request });
  async function connect(source, target, title) {
    await page.getByRole('button', { name: 'Links', exact: true }).click();
    const links = page.getByRole('region', { name: 'Data Links' });
    await links.getByLabel('Source port').selectOption(source);
    await links.getByLabel('Target port').selectOption(target);
    await links.getByRole('button', { name: 'Connect', exact: true }).press('Enter');
    await expect(links.getByText(title, { exact: true })).toBeVisible();
    await links.getByRole('button', { name: 'Close links' }).click();
  }

  await page.getByRole('button', { name: 'Add Directory', exact: true }).click();
  await expect(page.getByText('1 objects · 0 links')).toBeVisible();
  await page.getByLabel('Add analysis').selectOption('metadata');
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  await page.getByLabel('Add analysis').selectOption('comparison');
  await expect(page.getByText('3 objects · 0 links')).toBeVisible();
  const created = await view();
  const ids = Object.fromEntries(created.space.nodes.map(node => [node.content.typeId, node.id]));
  const directory = ids['forge.directory'];
  const meta = { projectId: created.space.projectId, targetId: ids['forge.metadata'] };
  const comp = { projectId: created.space.projectId, targetId: ids['forge.comparison'] };
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await connect(directory + ':files', meta.targetId + ':files', 'Directory · files → Metadata · files');
  await connect(directory + ':files', comp.targetId + ':sources', 'Directory · files → Comparison · sources');
  const linked = await view();
  const metaLink = linked.space.links.find(link => link.target.nodeId === meta.targetId).id;
  const compLink = linked.space.links.find(link => link.target.nodeId === comp.targetId).id;
  const firstPage = (await api('linkedAssets', { ...meta, linkId: metaLink, offset: 0, limit: 2 })).value;
  assert.equal(firstPage.total, 31);
  assert.equal(firstPage.unavailableCount, 2);
  const tail = (await api('linkedAssets', {
    ...meta, linkId: metaLink, sourceRevision: firstPage.sourceRevision, offset: firstPage.nextOffset, limit: 100,
  })).value;
  const names = [...firstPage.items, ...tail.items].map(item => item.name);
  assert.equal(names.length, new Set(names).size);
  assert.ok(names.includes('materials/z-edited.md'));
  assert.ok(names.includes('unknown.bin'));
  assert.ok(!names.some(name => /outside|linked-text|hidden|\.forge/.test(name)));
  assert.ok(firstPage.items.every(item => item.sha256 === null));

  await card(meta.targetId).dblclick();
  await metadata().getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(metadata().getByText('Current', { exact: true })).toBeVisible();
  await expect(metadata().getByText('2 entries unavailable in the source.', { exact: true })).toBeVisible();
  const oldMeta = (await api('metadataStatus', meta)).value.latest;
  const rows = (await api('metadataFiles', { ...meta, resultId: oldMeta.id, offset: 0, limit: 100 })).value.files;
  const row = name => rows.find(file => file.asset.name === name);
  assert.equal(row('begin.txt').asset.sha256, digest('alpha\n'));
  assert.equal(row('unknown.bin').asset.sha256, digest(Buffer.from([1, 2, 3])));
  assert.equal(row('unknown.bin').asset.format, null);
  assert.equal(row('invalid.png').issue, 'Image header is unavailable for the named format.');
  assert.deepEqual([row('left.png').image.width, row('left.png').image.height], [23, 14]);
  await back();

  await card(comp.targetId).dblclick();
  await compare().getByLabel('Left item').selectOption({ label: 'begin.txt' });
  await compare().getByRole('button', { name: 'Next right items' }).click();
  await compare().getByLabel('Right item').selectOption({ label: 'materials/z-edited.md' });
  await compare().getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(compare().getByText('1 added · 1 removed', { exact: true })).toBeVisible();
  const text = (await api('comparisonStatus', comp)).value.latest;
  assert.deepEqual(text.pair.map(item => item.choice.asset.sha256), [digest('alpha\n'), digest('beta\n')]);
  const first = path.join(project, 'begin.txt');
  const request = {
    ...comp, operationId: randomUUID(), baseRevision: linked.revision,
    left: { linkId: compLink, sourceRevision: text.source.revision, versionId: text.pair[0].choice.asset.versionId },
    right: { linkId: compLink, sourceRevision: text.source.revision, versionId: text.pair[1].choice.asset.versionId },
  };
  const writer = await open(first, 'r+');
  try {
    const during = await api('runComparison', request);
    assert.equal(during.error.code, 'SOURCE_CHANGED');
  } finally { await writer.close(); }
  assert.equal((await api('comparisonHistory', comp)).value.length, 1);
  const beforeEdit = await stat(first, { bigint: true });
  await writeFile(first, 'omega\n');
  await utimes(first, fixedTime, fixedTime);
  const afterEdit = await stat(first, { bigint: true });
  assert.equal(afterEdit.size, beforeEdit.size);
  assert.equal(afterEdit.mtimeNs, beforeEdit.mtimeNs);
  const staleCursor = await api('linkedAssets', { ...meta, linkId: metaLink, sourceRevision: firstPage.sourceRevision, offset: 0, limit: 2 });
  assert.equal(staleCursor.error.code, 'SOURCE_CHANGED');
  assert.equal((await api('runComparison', { ...request, operationId: randomUUID() })).error.code, 'SOURCE_CHANGED');
  await compare().getByRole('button', { name: 'Check source', exact: true }).click();
  await expect(compare().getByText('Stale', { exact: true })).toBeVisible();
  await expect(compare().getByText('alpha', { exact: true })).toBeVisible();
  await compare().getByLabel('Left item').selectOption({ label: 'left.png' });
  await compare().getByRole('button', { name: 'Next right items' }).click();
  await compare().getByLabel('Right item').selectOption({ label: 'right.png' });
  await compare().getByRole('button', { name: 'Recalculate', exact: true }).click();
  const images = compare().getByRole('region', { name: 'Image comparison' });
  await expect(images.getByRole('img', { name: 'left.png' })).toBeVisible();
  await expect(images.getByRole('img', { name: 'right.png' })).toBeVisible();
  const photo = (await api('comparisonStatus', comp)).value.latest;
  assert.equal(photo.mode, 'images');
  await writeFile(path.join(project, 'right.png'), Buffer.from(pixel[0], 'base64'));
  await compare().getByRole('button', { name: 'Check source', exact: true }).click();
  await expect(compare().getByText('Stale', { exact: true })).toBeVisible();
  await expect(images.getByRole('img', { name: 'left.png' })).toBeVisible();
  await expect(images.getByRole('img', { name: 'right.png' })).toHaveCount(0);
  assert.equal((await api('comparisonPreview', { ...comp, resultId: photo.id, side: 'right' })).error.code, 'SOURCE_CHANGED');
  assert.equal(await readFile(exterior, 'utf8'), secret);

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Directory sources qualification' }).click();
  await expect(page.getByText('3 objects · 2 links')).toBeVisible();
  const saved = (await api('comparisonHistory', comp)).value;
  assert.deepEqual(saved.map(item => item.summary.resultDigest), [photo.resultDigest, text.resultDigest]);
  assert.equal((await api('metadataStatus', meta)).value.state, 'stale');
  assert.deepEqual((await api('metadataHistory', meta)).value[0].summary, oldMeta);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, listedFiles: firstPage.total, unavailableEntries: firstPage.unavailableCount,
    protectedStorageAndExternalLinksExcluded: true, nestedPager: true, metadataHashesAndHeader: true,
    textAndImageComparison: true, concurrentWriterRejected: true, sameLengthExternalEditDetected: true,
    staleCursorAndSelectionRejected: true, revokedPreview: true, preservedResultsAfterRestart: true,
  }, null, 2) + '\n');
  console.log('Directory Data Links on Windows PASS. Evidence: ' + run);
} finally {
  await app.close();
}

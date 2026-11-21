import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';
import { onePagePdf } from './document-fixtures.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'asset-open-'));
const directory = path.join(run, 'Project');
const profile = path.join(run, 'Profile');
const expired = path.join(profile, 'forge-open-StaLe0');
await Promise.all([mkdir(directory), mkdir(expired, { recursive: true })]);
const expiredPdf = path.join(expired, 'document.pdf');
await writeFile(expiredPdf, 'Expired synthetic copy');
await chmod(expiredPdf, 0o400);
const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
await utimes(expired, yesterday, yesterday);
const unrelated = path.join(profile, 'unrelated.pdf');
await writeFile(unrelated, 'Other file');
const useNative = process.argv.includes('--native-pdf');

const image = path.join(root, 'tests', 'fixtures', 'forge-test-grid.png');
const imageBytes = await readFile(image);
const actualWidth = imageBytes.readUInt32BE(16);
const actualHeight = imageBytes.readUInt32BE(20);
const document = path.join(run, 'Forge viewing qualification.pdf');
const jpeg = path.join(run, 'fixture.jpeg');
const webp = path.join(run, 'fixture.webp');
await writeFile(document, onePagePdf('Forge viewing qualification'));

const app = await _electron.launch({
  executablePath,
  args: [root],
  env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
});
let observations;
try {
  await app.evaluate(({ dialog, shell }, paths) => {
    const nativeOpen = shell.openPath.bind(shell);
    globalThis.qualifiedOpen = { attempts: [], mode: 'reject' };
    shell.openPath = async file => {
      globalThis.qualifiedOpen.attempts.push(file);
      if (globalThis.qualifiedOpen.mode === 'native') return nativeOpen(file);
      return globalThis.qualifiedOpen.mode === 'reject' ? 'Viewer unavailable' : '';
    };
    dialog.showOpenDialog = async (_window, options) => ({
      canceled: false,
      filePaths: options.properties.includes('openDirectory') ? [paths.directory] : paths.inputs,
    });
  }, { directory, inputs: [image, document, jpeg, webp] });

  const page = await app.firstWindow();
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 240;
    const context = canvas.getContext('2d');
    context.fillStyle = '#325444';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#e1ba85';
    context.fillRect(40, 30, 200, 110);
    return [canvas.toDataURL('image/jpeg'), canvas.toDataURL('image/webp')];
  });
  for (const [index, file] of [jpeg, webp].entries()) {
    assert.match(encoded[index], new RegExp('^data:image/' + path.extname(file).slice(1) + ';base64,'));
    await writeFile(file, Buffer.from(encoded[index].split(',')[1], 'base64'));
  }
  await expect.poll(async () => (await readdir(profile)).includes('forge-open-StaLe0')).toBe(false);
  assert.equal(await readFile(unrelated, 'utf8'), 'Other file');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Open fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  await expect(page.getByText('Imported 4 of 4 files')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss import results' }).click();
  const projectState = (await page.evaluate(() => window.forge.project.view())).value;
  const imageNode = projectState.space.nodes.find(node => node.content.asset.format === 'png');
  const pdfNode = projectState.space.nodes.find(node => node.content.asset.format === 'pdf');
  const card = node => page.locator('.react-flow__node[data-id="' + node.id + '"]');
  const details = page.getByRole('region', { name: 'File details' });
  const openButton = details.getByRole('button', { name: 'Open file', exact: true });
  const back = page.getByRole('button', { name: 'Back to Space', exact: true });
  const privateCopies = async () => (await readdir(profile)).filter(name => name.startsWith('forge-open-'));

  await card(imageNode).dblclick();
  await expect.poll(() => details.getByRole('img').evaluate(element => Math.max(element.naturalWidth, element.naturalHeight))).toBe(512);
  await openButton.click();
  const full = details.getByRole('region', { name: 'Full-size image' });
  const visible = full.getByRole('img');
  await expect(visible).toBeVisible();
  await expect.poll(() => visible.evaluate(element => [element.naturalWidth, element.naturalHeight])).toEqual([actualWidth, actualHeight]);
  const src = await visible.getAttribute('src');
  assert.match(src, /^forge-image:\/\/view\/[a-f0-9-]+$/);
  const [imageCopy] = await privateCopies();
  assert.deepEqual(await readFile(path.join(profile, imageCopy, 'document.png')), imageBytes);
  await full.getByRole('button', { name: 'Actual size' }).click();
  assert.equal(Math.round((await visible.boundingBox()).width), actualWidth);
  await full.getByRole('button', { name: 'Fit image' }).click();
  const protectedFixture = await app.evaluate(async ({ BrowserWindow }, data) => {
    const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      await foreign.loadFile(data.entry);
      return await foreign.webContents.executeJavaScript('new Promise(resolve => { const image = new Image(); image.onload = () => resolve(false); image.onerror = () => resolve(true); image.src = ' + JSON.stringify(data.src) + '; })');
    } finally {
      foreign.destroy();
    }
  }, { entry: path.join(root, 'dist', 'index.html'), src });
  assert.equal(protectedFixture, true, 'An image capability is unusable in another window of the same session');
  await full.getByRole('button', { name: 'Close image' }).click();
  await expect(openButton).toBeFocused();
  await expect.poll(privateCopies).toEqual([]);
  await openButton.click();
  await expect.poll(() => visible.evaluate(element => element.naturalWidth)).toBe(actualWidth);
  await back.click();
  await expect.poll(privateCopies).toEqual([]);
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  for (const format of ['jpeg', 'webp']) {
    await card(projectState.space.nodes.find(node => node.content.asset.format === format)).dblclick();
    await openButton.click();
    await expect.poll(() => visible.evaluate(element => [element.naturalWidth, element.naturalHeight])).toEqual([640, 240]);
    await full.getByRole('button', { name: 'Close image' }).click();
    await back.click();
    await expect.poll(privateCopies).toEqual([]);
  }

  await card(pdfNode).dblclick();
  await openButton.click();
  await expect(details.getByRole('alert')).toHaveText('Windows could not open the file. Set a default app for this format or download the original.');
  await expect.poll(privateCopies).toEqual([]);
  await app.evaluate(({ BrowserWindow }, mode) => {
    globalThis.qualifiedOpen.mode = mode;
    if (mode === 'native') BrowserWindow.getAllWindows()[0].show();
  }, useNative ? 'native' : 'accept');
  await openButton.click();
  await expect(details.getByText('Sent to the default app')).toBeVisible();
  const attempts = await app.evaluate(() => globalThis.qualifiedOpen.attempts);
  assert.equal(attempts.length, 2);
  assert.equal(path.basename(attempts[1]), 'document.pdf');
  assert.equal(path.dirname(path.dirname(attempts[1])).toLowerCase(), profile.toLowerCase());
  assert.deepEqual(await readFile(attempts[1]), await readFile(document));
  assert.equal((await stat(attempts[1])).mode & 0o200, 0);

  const pdfAsset = pdfNode.content.asset;
  const blob = path.join(directory, 'assets', 'asset-' + pdfAsset.versionId + '.pdf');
  const corrupt = await readFile(blob);
  corrupt[corrupt.indexOf(Buffer.from('Forge viewing'))] = 0x58;
  await writeFile(blob, corrupt);
  await openButton.click();
  await expect(details.getByRole('alert')).toHaveText('The stored file failed its integrity check');
  assert.equal(await app.evaluate(() => globalThis.qualifiedOpen.attempts.length), 2);
  assert.equal((await page.evaluate(() => window.forge.project.view())).value.revision, 1);
  await back.click();
  await card(imageNode).dblclick();
  await openButton.click();
  await expect.poll(() => visible.evaluate(element => element.naturalWidth)).toBe(actualWidth);
  assert.equal((await privateCopies()).length, 2);
  observations = {
    platform: process.platform, fullImageWidth: actualWidth, fullImageHeight: actualHeight,
    testedFullImageFormats: ['png', 'jpeg', 'webp'],
    fitAndActualSizeVerified: true, fullImageSourceBytesExact: true, secondWindowDenied: true,
    imageCloseAndBackDeletePrivateCopies: true, expiredCopyReapedWithoutDeletingUnrelatedFiles: true,
    documentMode: useNative ? 'native OS association' : 'shell stub',
    pdfViewerMissingAndSuccessFeedback: true, privatePdfMatchesManagedBytes: true, privatePdfReadOnly: true,
    tamperedPdfNeverSentToShell: true, revisionUnchangedByAllFileReads: true,
    retainedDocumentDirectory: path.basename(path.dirname(attempts[1])),
  };
} finally {
  await app.close();
}
const afterQuit = (await readdir(profile)).filter(name => name.startsWith('forge-open-'));
assert.deepEqual(afterQuit, [observations.retainedDocumentDirectory]);
await writeFile(path.join(run, 'observations.json'), JSON.stringify({
  ...observations, normalQuitDeletesOpenImage: true, documentRemainsAvailableForViewerAfterQuit: true,
}, null, 2) + '\n');
console.log('Full-size image and document opening PASS. Evidence: ' + run);

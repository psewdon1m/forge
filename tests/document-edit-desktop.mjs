import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';
import { onePagePdf, oneParagraphDocx } from './document-fixtures.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'document-edit-'));
const directory = path.join(run, 'Project');
const profile = path.join(run, 'Profile');
await mkdir(directory);
const pdf = path.join(run, 'Example.pdf');
const docx = path.join(run, 'Example.docx');
const alternative = path.join(run, 'Replacement.docx');
const pdfOriginal = onePagePdf('Original PDF');
const pdfEdited = onePagePdf('Edited PDF');
const docxOriginal = oneParagraphDocx('Original DOCX');
const docxEdited = oneParagraphDocx('Edited DOCX');
await Promise.all([writeFile(pdf, pdfOriginal), writeFile(docx, docxOriginal), writeFile(alternative, oneParagraphDocx('A separate replacement'))]);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
  });
  await app.evaluate(({ dialog, shell }, data) => {
    const state = { confirmation: 0, chooser: { outcome: 'canceled' }, selections: [], confirmations: [], folders: [] };
    globalThis.editFixture = state;
    globalThis.forgeQualification.chooseDocumentEditor = async file => {
      state.selections.push(file);
      return state.chooser;
    };
    dialog.showMessageBox = async (_owner, options) => {
      if (options.cancelId !== 0 || options.defaultId !== 0) throw new Error('Confirmation must default to Cancel');
      state.confirmations.push(options.message);
      return { response: state.confirmation, checkboxChecked: false };
    };
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false,
      filePaths: options.properties.includes('openDirectory') ? [data.directory]
        : options.properties.includes('multiSelections') ? data.inputs : [data.alternative],
    });
    shell.openPath = async location => {
      state.folders.push(location);
      return '';
    };
  }, { directory, inputs: [pdf, docx], alternative });
  return app;
}

async function enable(app, confirmation, chooser = 'chosen') {
  const selection = typeof chooser === 'string' ? { outcome: chooser } : chooser;
  await app.evaluate((_electron, data) => { Object.assign(globalThis.editFixture, data); }, { confirmation, chooser: selection });
}

function editActions(page) {
  return page.getByRole('region', { name: 'Document editing' });
}

async function openCard(page, id) {
  await page.locator('.react-flow__node[data-id="' + id + '"]').dblclick();
}

async function openEditDirectories() {
  return (await readdir(profile)).filter(name => name.startsWith('forge-edit-'));
}

const projectView = page => page.evaluate(() => window.forge.project.view()).then(result => result.value);
const originalPath = asset => path.join(directory, 'assets', 'asset-' + asset.versionId + '.' + asset.format);

let app = await launch();
try {
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Document edit fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  await expect(page.getByText('Imported 2 of 2 files')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss import results' }).click();
  const baseline = await projectView(page);
  assert.equal(baseline.revision, 1);
  const pdfNode = baseline.space.nodes.find(node => node.content.asset.format === 'pdf');
  const docxNode = baseline.space.nodes.find(node => node.content.asset.format === 'docx');
  const pdfAsset = pdfNode.content.asset;
  const docxAsset = docxNode.content.asset;
  await openCard(page, pdfNode.id);
  const startEdit = () => editActions(page).getByRole('button', { name: 'Edit copy', exact: true });
  const importEdit = () => editActions(page).getByRole('button', { name: 'Import changes', exact: true });
  const removeCopy = () => editActions(page).getByRole('button', { name: 'Discard copy', exact: true });
  const back = () => page.getByRole('button', { name: 'Back to Space', exact: true });

  await startEdit().click();
  await expect(editActions(page).getByText('Editor selection canceled')).toBeVisible();
  assert.equal(await app.evaluate(() => globalThis.editFixture.selections.length), 0);
  assert.deepEqual(await openEditDirectories(), []);
  await enable(app, 1, 'canceled');
  await startEdit().click();
  await expect(editActions(page).getByText('Editor selection canceled')).toBeVisible();
  await expect.poll(() => app.evaluate(() => globalThis.editFixture.selections.length)).toBe(1);
  await expect.poll(openEditDirectories).toEqual([]);
  await enable(app, 1, { outcome: 'failed', windowsFailure: { operation: 'chooser', hresult: '0x80070005' } });
  await startEdit().click();
  await expect(editActions(page).getByRole('alert')).toContainText('The Windows editor chooser returned 0x80070005.');
  await expect(editActions(page).getByRole('alert')).toContainText('Replace file.');
  assert.deepEqual(await openEditDirectories(), []);
  await enable(app, 1);
  await startEdit().click();
  await expect(importEdit()).toBeVisible();
  const pdfCopy = await app.evaluate(() => globalThis.editFixture.selections.at(-1));
  assert.equal(path.basename(pdfCopy), 'document.pdf');
  assert.equal(path.dirname(path.dirname(pdfCopy)).toLowerCase(), profile.toLowerCase());
  assert.ok((await stat(pdfCopy)).mode & 0o200);
  assert.deepEqual(await readFile(pdfCopy), pdfOriginal);
  await enable(app, 1, { outcome: 'failed', windowsFailure: { operation: 'initialize', hresult: '0x80010106' } });
  await editActions(page).getByRole('button', { name: 'Reopen in editor', exact: true }).click();
  await expect(editActions(page).getByRole('alert')).toContainText('Windows editor selection setup returned 0x80010106.');
  await expect(editActions(page).getByRole('alert')).toContainText('Open copy folder');
  assert.deepEqual(await readFile(pdfCopy), pdfOriginal);

  await enable(app, 0);
  await importEdit().click();
  await expect(page.getByText('Edit import canceled')).toBeVisible();
  await enable(app, 1);
  await importEdit().click();
  await expect(page.getByText(/Edit import failed · The edit copy is unchanged/)).toBeVisible();
  await writeFile(pdfCopy, 'Invalid file contents');
  await importEdit().click();
  await expect(page.getByText(/Edit import failed · Invalid PDF header/)).toBeVisible();
  assert.equal((await projectView(page)).revision, 1);
  await writeFile(pdfCopy, pdfEdited);

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: 'Document edit fixture' }).click();
  await openCard(page, pdfNode.id);
  await expect(importEdit()).toBeVisible();
  await enable(app, 1);
  await importEdit().click();
  await expect(page.getByText('Edited file saved as a new version')).toBeVisible();
  await expect(editActions(page).getByText(/The card has a newer version/)).toBeVisible();
  const editedPdf = (await projectView(page)).space.nodes.find(node => node.id === pdfNode.id).content.asset;
  assert.equal(editedPdf.name, pdfAsset.name);
  assert.equal(editedPdf.assetId, pdfAsset.assetId);
  assert.notEqual(editedPdf.versionId, pdfAsset.versionId);
  assert.deepEqual(await readFile(originalPath(pdfAsset)), pdfOriginal);
  assert.deepEqual(await readFile(originalPath(editedPdf)), pdfEdited);
  assert.deepEqual(await readFile(pdfCopy), pdfEdited);
  await enable(app, 0);
  await removeCopy().click();
  await expect(removeCopy()).toBeEnabled();
  assert.deepEqual(await readFile(pdfCopy), pdfEdited);
  await enable(app, 1);
  await removeCopy().click();
  await expect(startEdit()).toBeVisible();
  assert.deepEqual(await openEditDirectories(), []);

  await back().click();
  await openCard(page, docxNode.id);
  await startEdit().click();
  await expect(importEdit()).toBeVisible();
  const docxCopy = await app.evaluate(() => globalThis.editFixture.selections.at(-1));
  assert.deepEqual(await readFile(docxCopy), docxOriginal);
  await writeFile(docxCopy, docxEdited);
  await page.getByRole('button', { name: 'Replace file', exact: true }).click();
  await expect(page.getByText('File replaced', { exact: true })).toBeVisible();
  await expect(editActions(page).getByText(/The card has a newer version/)).toBeVisible();
  await expect(importEdit()).toHaveCount(0);
  const replaced = await projectView(page);
  const replacedDocx = replaced.space.nodes.find(node => node.id === docxNode.id).content.asset;
  const forbidden = await page.evaluate(input => window.forge.project.importEditCopy(input), {
    projectId: replaced.space.projectId, nodeId: docxNode.id, versionId: replacedDocx.versionId,
    operationId: randomUUID(), baseRevision: replaced.revision,
  });
  assert.equal(forbidden.error.code, 'EDIT_COPY_STALE');
  await editActions(page).getByRole('button', { name: 'Open copy folder' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.editFixture.folders.at(-1))).toBe(path.dirname(docxCopy));
  assert.deepEqual(await readFile(docxCopy), docxEdited);
  assert.equal((await projectView(page)).revision, 3);
  await back().click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="' + docxNode.id + '"]').getByText(docxAsset.name)).toBeVisible();
  await openCard(page, docxNode.id);
  await importEdit().click();
  await expect(page.getByText('Edited file saved as a new version')).toBeVisible();
  const finished = await projectView(page);
  const editedDocx = finished.space.nodes.find(node => node.id === docxNode.id).content.asset;
  assert.equal(finished.revision, 5);
  assert.equal(editedDocx.assetId, docxAsset.assetId);
  assert.equal(editedDocx.name, docxAsset.name);
  assert.deepEqual(await readFile(originalPath(docxAsset)), docxOriginal);
  assert.deepEqual(await readFile(originalPath(editedDocx)), docxEdited);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform, editor: 'controlled fixture writing valid replacement documents',
    confirmsLaunchImportAndDiscard: true, canceledLaunchCreatesNoEdit: true, missingEditorFeedback: true,
    writableBytesMatchOriginal: true, draftRecoveredAfterAppRestart: true, unchangedAndInvalidRejected: true,
    savedPdfAndDocxVersionsKeepOriginalBytesAndIdentity: true, staleImportRejectedAndCopyRecoverable: true,
    undoRevivesMatchingEditSession: true, revision: finished.revision,
  }, null, 2) + '\n');
  console.log('PDF and DOCX edit-copy round trip PASS. Evidence: ' + run);
} finally {
  await app.close();
}

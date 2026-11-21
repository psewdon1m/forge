import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'dataset-ui-'));
const directory = path.join(run, 'Project');
await mkdir(directory);
const invalid = path.join(run, 'invalid.csv');
const selected = path.join(run, 'shoot-costs.csv');
const csv = path.join(run, 'safe-export.csv');
const tsv = path.join(run, 'safe-export.tsv');
const screenshot = path.join(run, 'dataset.png');
const original = [
  'Name,Cost,Ready,Date,Expression',
  'Alpha,12,TRUE,2024-02-29,"=report, ""draft"""',
  'Beta,-2,false,2026-01-02,  +caption',
  'Missing',
  ...Array.from({ length: 27 }, (_, index) => 'Clip ' + (index + 1) + ',' + (20 + index) + ',true,2026-01-01,Reference'),
].join('\r\n') + '\r\n';
await writeFile(invalid, 'Name,Cost\r\nReady,2\r\nInvalid,not a number\r\n');
await writeFile(selected, original);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, 'Profile') },
  });
  await app.evaluate(({ dialog }, paths) => {
    globalThis.datasetPicker = paths.invalid;
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false, filePaths: [options.properties.includes('openDirectory') ? paths.directory : globalThis.datasetPicker],
    });
    dialog.showSaveDialog = async (_owner, options) => ({
      canceled: false, filePath: options.defaultPath.endsWith('.tsv') ? paths.tsv : paths.csv,
    });
  }, { directory, invalid, csv, tsv });
  return app;
}

function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const invoke = (page, method, input) => page.evaluate(([method, input]) => window.forge.project[method](input), [method, input]);
const button = (region, name) => region.getByRole('button', { name, exact: true });
const plain = page => page.getByRole('region', { name: 'Dataset table', exact: true });
const preview = page => page.getByRole('region', { name: 'Dataset import preview', exact: true });
const rows = page => plain(page).getByLabel('Dataset rows');

let app = await launch();
let nodeId;
let projectId;
let saved;
try {
  const page = await app.firstWindow();
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Shoot Dataset');
  await button(page, 'Create project').click();
  await button(page, 'Add Dataset').click();
  await expect(page.getByText('1 objects · 0 links')).toBeVisible();
  ({ space: { projectId, nodes: [{ id: nodeId }] } } = value(await invoke(page, 'view')));
  await button(page, 'Open Dataset').press('Enter');
  await button(plain(page), 'Open CSV or TSV').click();
  await preview(page).getByLabel('Type for column 2 Cost').selectOption('number');
  await expect(preview(page).getByRole('alert')).toContainText('Row 3, column 2. Expected a finite number');
  await expect(button(preview(page), 'Import table')).toBeDisabled();

  await app.evaluate((_, file) => { globalThis.datasetPicker = file; }, selected);
  await button(plain(page), 'Open CSV or TSV').click();
  await expect(preview(page).getByRole('heading')).toHaveText('shoot-costs.csv');
  await preview(page).getByLabel('Delimiter').selectOption('tab');
  await expect(preview(page).getByRole('alert')).toContainText('Unexpected quote');
  await preview(page).getByLabel('Delimiter').selectOption('comma');
  await preview(page).getByLabel('Type for column 2 Cost').selectOption('number');
  await preview(page).getByLabel('Type for column 3 Ready').selectOption('boolean');
  await preview(page).getByLabel('Type for column 4 Date').selectOption('date');
  await expect(button(preview(page), 'Import table')).toBeEnabled();
  await writeFile(selected, 'Other table\r\nChanged after preview\r\n');
  await button(preview(page), 'Import table').click();
  await expect(rows(page).getByText('Alpha', { exact: true })).toBeVisible();

  const query = { projectId, nodeId, query: { offset: 0, limit: 25 } };
  const first = value(await invoke(page, 'datasetPage', query));
  assert.deepEqual(first.columns.map(column => column.kind), ['string', 'number', 'boolean', 'date', 'string']);
  assert.deepEqual(first.rows[0].cells.map(cell => cell.value), ['Alpha', 12, true, '2024-02-29', '=report, "draft"']);
  assert.deepEqual(first.rows[2].cells.map(cell => cell.value), ['Missing', null, null, null, null]);
  assert.equal(first.total, 30);
  await button(plain(page), 'Next rows').click();
  await expect(plain(page).getByText('26–30 of 30')).toBeVisible();
  await button(plain(page), 'Previous rows').click();
  await button(rows(page), 'Sort column 2 Cost').click();
  await expect(rows(page).getByRole('row').nth(1)).toContainText('Beta');
  await plain(page).getByLabel('Filter rows').fill('alpha');
  await button(plain(page), 'Apply filter').click();
  await expect(plain(page).getByText('1–1 of 1')).toBeVisible();
  await button(rows(page), 'Edit row 1 column 2 Cost').click();
  await plain(page).getByLabel('Value for row 1, column 2').fill('bad');
  await button(plain(page), 'Save cell').click();
  await expect(page.getByText(/Save failed.*Row 1, column 2/)).toBeVisible();
  await expect(plain(page).getByLabel('Value for row 1, column 2')).toHaveValue('bad');
  await plain(page).getByLabel('Value for row 1, column 2').fill('003.25');
  await button(plain(page), 'Save cell').click();
  await expect(rows(page).getByText('003.25', { exact: true })).toBeVisible();
  const stale = await invoke(page, 'datasetPage', { ...query, query: { ...query.query, sourceRevision: first.sourceRevision } });
  assert.equal(stale.error.code, 'SOURCE_CHANGED');
  saved = value(await invoke(page, 'datasetPage', query));
  assert.equal(saved.rows[0].id, first.rows[0].id);
  assert.deepEqual(saved.rows[0].cells[1], { raw: '003.25', value: 3.25 });

  await button(plain(page), 'Export CSV').click();
  await expect(plain(page).getByText('CSV saved in safe-text mode.')).toBeVisible();
  await button(plain(page), 'Export TSV').click();
  await expect(plain(page).getByText('TSV saved in safe-text mode.')).toBeVisible();
  const csvBytes = await readFile(csv);
  const tsvText = await readFile(tsv, 'utf8');
  assert.match(csvBytes.toString(), /"Alpha","003.25","TRUE","2024-02-29","text: =report, ""draft"""/);
  assert.match(tsvText, /"Beta"\t"-2"\t"false"\t"2026-01-02"\t"text:   \+caption"/);
  await button(plain(page), 'Export CSV').click();
  await expect(plain(page).getByRole('alert')).toContainText('exists');
  assert.deepEqual(await readFile(csv), csvBytes);

  await button(plain(page), 'Paste table').click();
  await plain(page).getByLabel('Tabular text').fill('x'.repeat(512 * 1024 + 1));
  await expect(plain(page).getByRole('alert')).toContainText('512 KiB');
  await plain(page).getByLabel('Tabular text').fill('Name\tCount\r\nLens\t3');
  await button(plain(page), 'Preview pasted table').click();
  await expect(preview(page).getByLabel('Delimiter')).toHaveValue('tab');
  await expect(preview(page).getByRole('cell', { name: 'Lens', exact: true })).toBeVisible();
  await button(preview(page), 'Cancel preview').click();
  await button(plain(page), 'Clear filter').click();
  await button(plain(page), 'Clear sort').click();
  await expect(rows(page).getByText('003.25', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw new Error('Dataset capture is empty');
    return image.toPNG().toString('base64');
  });
  await writeFile(screenshot, Buffer.from(png, 'base64'));
} finally {
  await app.close();
}

app = await launch();
try {
  const page = await app.firstWindow();
  await button(page, 'Projects').click();
  await button(page, 'Shoot Dataset').click();
  await page.locator('.react-flow__node[data-id="' + nodeId + '"]').dblclick();
  await expect(rows(page).getByText('003.25', { exact: true })).toBeVisible();
  const restored = value(await invoke(page, 'datasetPage', { projectId, nodeId, query: { offset: 0, limit: 25 } }));
  assert.deepEqual(restored, saved);
} finally {
  await app.close();
}

const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
console.log(JSON.stringify({
  outcome: 'PASS', run, screenshot, csvSha256: await sha(csv), tsvSha256: await sha(tsv),
  coreSha256: await sha(path.join(root, '.local/bin/forge-core.exe')),
  localizedImportAndEditErrors: true, stableTypedRows: true, paginationAndSorting: true,
  pasteLimit: true, pasteTsvPreview: true, selectedSnapshotPreserved: true, safeTextExports: true, reopened: true,
}, null, 2));

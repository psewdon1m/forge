import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const evidence = path.join(root, '.local', 'qualification');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'plain-panes-'));
const project = path.join(run, 'Project');
await mkdir(project);
const app = await _electron.launch({ executablePath, args: [root], timeout: 25_000, env: {
  ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, 'Profile'),
} });

try {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, project);
  const page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  const button = (group, name) => group.getByRole('button', { name, exact: true });
  const api = (method, input) => page.evaluate(([method, input]) => window.forge.project[method](input), [method, input]);
  const val = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value; };
  const view = () => api('view').then(val);
  const edit = async change => {
    const current = await view();
    return val(await api('apply', { projectId: current.space.projectId, baseRevision: current.revision, operationId: randomUUID(), change }));
  };
  const add = async (type, label, data, x) => {
    const id = randomUUID();
    await edit({ kind: 'add', node: { id, label, position: { x, y: 96 },
      content: { kind: 'portal', typeId: 'forge.' + type, schemaVersion: 1, plainId: randomUUID(), payload: JSON.stringify(data) } } });
    return id;
  };
  const resize = async (width, height = 840) => {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  };
  const visiblePanes = () => page.evaluate(() => [...document.querySelectorAll('.plain-columns > .plain:not([hidden])')].map(pane => {
    const bounds = pane.getBoundingClientRect();
    return { heading: pane.querySelector('h2')?.textContent, left: bounds.left, top: bounds.top, right: bounds.right,
      width: bounds.width, height: bounds.height };
  }));

  await resize(1440);
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Comparison desk');
  await button(page, 'Create project').click();
  await expect(page.getByRole('heading', { name: 'Comparison desk', exact: true })).toBeVisible();
  const research = await add('research', 'Lighting evidence', { sources: [], citations: [], conclusions: [] }, 64);
  const dataset = await add('dataset', 'Measurements', { columns: [{ name: 'Lamp', kind: 'string' }, { name: 'Exposure', kind: 'number' }],
    rows: Array.from({ length: 55 }, (_, index) => ({ id: randomUUID(), cells: [`${index < 40 ? 'alpha' : 'beta'}-${index + 1}`, String(index + 1)] })) }, 350);
  const site = await add('site', 'Reference site', { reference: null }, 640);
  const galleryA = await add('gallery', 'Selected plates', { items: [] }, 924);
  const galleryB = await add('gallery', 'Other plates', { items: [] }, 1196);
  await edit({ kind: 'editResearch', id: research, action: { kind: 'manual', sourceId: null, title: 'Field observation', text: 'Original fixture exposure.' } });
  const oldSource = JSON.parse((await view()).space.nodes.find(node => node.id === research).content.payload).sources[0];
  await edit({ kind: 'editResearch', id: research, action: { kind: 'manual', sourceId: oldSource.id, title: 'Field observation', text: 'Revised fixture exposure.' } });

  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  const canvasCard = page.locator(`.react-flow__node[data-id="${research}"]`);
  await canvasCard.dblclick();
  const left = page.getByRole('region', { name: 'Lighting evidence', exact: true });
  const right = page.getByRole('region', { name: 'Measurements', exact: true });
  const researchHeading = left.getByRole('heading', { name: 'Lighting evidence', exact: true });
  const datasetHeading = right.getByRole('heading', { name: 'Measurements', exact: true });
  await expect(researchHeading).toBeFocused();
  await left.getByLabel('Saved source version').selectOption(oldSource.activeRevision);
  await left.getByLabel('Search saved sources').fill('Original fixture');
  await page.getByLabel('Open beside', { exact: true }).selectOption(dataset);
  await expect(datasetHeading).toBeFocused();
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  const wide = await visiblePanes();
  assert.equal(wide.length, 2);
  assert.ok(wide.every(bounds => bounds.width > 600 && bounds.height > 420));
  assert.equal(wide[0].top, wide[1].top);
  assert.ok(wide[0].right <= wide[1].left && wide[1].right <= 1440);

  await right.getByLabel('Filter rows').fill('alpha');
  await button(right, 'Apply filter').click();
  await expect(right.getByText('1–25 of 40', { exact: true })).toBeVisible();
  await button(right, 'Next rows').click();
  await expect(right.getByText('26–40 of 40', { exact: true })).toBeVisible();
  await resize(760, 700);
  const switches = page.getByRole('group', { name: 'Shown panel', exact: true });
  await expect(switches).toBeVisible();
  await expect(button(switches, 'Show Measurements')).toHaveAttribute('aria-pressed', 'true');
  await expect(right).toBeVisible();
  await expect(left).toBeHidden();
  const narrow = await visiblePanes();
  assert.deepEqual(narrow.map(bounds => bounds.heading), ['Measurements']);
  assert.ok(narrow[0].width <= 760 && narrow[0].height > 350);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 760);

  await button(switches, 'Show Lighting evidence').press('Enter');
  await expect(researchHeading).toBeFocused();
  await expect(left.getByLabel('Search saved sources')).toHaveValue('Original fixture');
  await expect(left.getByLabel('Saved source version')).toHaveValue(oldSource.activeRevision);
  await expect(left.getByLabel('Saved source text')).toHaveValue('Original fixture exposure.');
  await button(left, 'Add manual source').click();
  await left.getByLabel('Source title').fill('Second study');
  const researchDraft = left.getByRole('textbox', { name: 'Source text', exact: true });
  await researchDraft.fill('Draft kept through the panel change.');
  await button(switches, 'Show Measurements').click();
  await expect(right.getByLabel('Filter rows')).toHaveValue('alpha');
  await expect(right.getByText('26–40 of 40', { exact: true })).toBeVisible();
  await button(right, 'Edit row 26 column 2 Exposure').click();
  const datasetDraft = right.getByLabel('Value for row 26, column 2');
  await datasetDraft.fill('26.75');
  await button(page, 'Back to Space').click();
  await expect(page.getByText('Save or discard changes in Lighting evidence before leaving.', { exact: true })).toBeVisible();
  await button(right, 'Close Measurements').click();
  await expect(page.getByText('Save or discard changes in Measurements before leaving.', { exact: true })).toBeVisible();
  await expect(datasetDraft).toHaveValue('26.75');

  await resize(1440);
  await expect(switches).toBeHidden();
  await expect(datasetDraft).toHaveValue('26.75');
  await expect(researchDraft).toHaveValue('Draft kept through the panel change.');
  await button(left, 'Save source version').click();
  await expect(left.getByRole('textbox', { name: 'Source title', exact: true })).toHaveCount(0);
  await expect(datasetDraft).toHaveValue('26.75');
  await button(left, 'Close Lighting evidence').click();
  await expect(left).toBeHidden();
  await expect(right).toBeVisible();
  await expect(datasetHeading).toBeFocused();
  await expect(datasetDraft).toHaveValue('26.75');
  await button(right, 'Save cell').click();
  await expect(datasetDraft).toHaveCount(0);
  const state = await view();
  const materials = JSON.parse(state.space.nodes.find(node => node.id === research).content.payload);
  const table = JSON.parse(state.space.nodes.find(node => node.id === dataset).content.payload);
  assert.ok(materials.sources.some(source => source.versions[0].title === 'Second study'));
  assert.equal(table.rows[25].cells[1], '26.75');

  await page.getByLabel('Open beside', { exact: true }).selectOption(site);
  const sitePanel = page.getByRole('region', { name: 'Reference site', exact: true });
  await expect(sitePanel).toBeVisible();
  await sitePanel.getByLabel('HTTPS address').fill('https://127.0.0.1:1/');
  await button(sitePanel, 'Go').click();
  const native = () => app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const browser = window.contentView.children.find(item => item.webContents && item.webContents !== window.webContents);
    return browser ? { visible: browser.getVisible(), bounds: browser.getBounds() } : null;
  });
  await expect.poll(native).toMatchObject({ visible: true });
  const siteBounds = (await native()).bounds;
  assert.ok(siteBounds.x >= 720 && siteBounds.x + siteBounds.width <= 1440);
  await resize(760, 700);
  await button(switches, 'Show Measurements').click();
  await expect(right).toBeVisible();
  await expect(sitePanel).toBeHidden();
  await expect.poll(native).toMatchObject({ visible: false });
  await button(switches, 'Show Reference site').click();
  await expect.poll(native).toMatchObject({ visible: true });
  await button(sitePanel, 'Close Reference site').click();
  await expect.poll(native).toBeNull();
  await expect(right).toBeVisible();
  await button(page, 'Back to Space').click();
  await expect(canvasCard).toBeVisible();
  await expect.poll(() => canvasCard.evaluate(node => ({ focus: node.contains(document.activeElement),
    actual: document.activeElement?.getAttribute('data-id') ?? document.activeElement?.tagName, expected: node.getAttribute('data-id'),
  }))).toMatchObject({ focus: true, expected: research });

  await resize(1440);
  const plate = path.join(run, 'plate.png');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = '#365754';
    context.fillRect(0, 0, 16, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(plate, Buffer.from(png, 'base64'));
  await page.locator(`.react-flow__node[data-id="${galleryA}"]`).dblclick();
  await page.getByLabel('Open beside', { exact: true }).selectOption(galleryB);
  await expect(page.getByRole('heading', { name: 'Other plates', exact: true })).toBeFocused();
  const zone = page.getByRole('region', { name: 'Selected plates', exact: true }).getByRole('region', { name: 'Gallery', exact: true });
  const bounds = await zone.boundingBox();
  assert.ok(bounds);
  const point = { x: Math.floor(bounds.x + 18), y: Math.floor(bounds.y + 26) };
  const cdp = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files: [plate], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, ...point, data });
    await expect(page.getByText('Imported 1 of 1 files', { exact: true })).toBeVisible();
  } finally { await cdp.detach(); }
  const afterDrop = await view();
  const items = id => JSON.parse(afterDrop.space.nodes.find(node => node.id === id).content.payload).items;
  assert.equal(items(galleryA).length, 1);
  assert.equal(items(galleryB).length, 0);

  await writeFile(path.join(run, 'observations.json'), JSON.stringify({ outcome: 'PASS', wide, narrow,
    independentSelectionAndFilter: true, draftsSurvivedSwitchAndResize: true, protectedClosingDirtyPanel: true,
    sameLevelAndNoOverlap: true, savingOneKeptOtherDraft: true, closingOnePromotedOther: true,
    independentWritesVerified: true, keyboardFocus: true, siteViewScopedAndHidden: true, siteBounds, galleryDropTargeted: true }, null, 2) + '\n');
  console.log('Plain pane layout, state and Site bounds PASS. Evidence: ' + run);
} finally { await app.close(); }

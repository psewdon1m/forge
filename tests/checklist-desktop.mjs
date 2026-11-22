import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'checklist-ui-'));
const directory = path.join(run, 'Project');
await mkdir(directory);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, 'Profile') },
  });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, directory);
  return app;
}

const button = (page, name) => page.getByRole('button', { name, exact: true });
const plain = page => page.getByRole('region', { name: 'Checklist tasks', exact: true });
const grouped = page => plain(page).getByRole('region', { name: 'Lighting', exact: true });
const invoke = async (page, name, data) => page.evaluate(([name, data]) => window.forge.project[name](data), [name, data]);
function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
async function apply(page, change) {
  const view = value(await invoke(page, 'view'));
  return value(await invoke(page, 'apply', {
    projectId: view.space.projectId, baseRevision: view.revision, operationId: randomUUID(), change,
  }));
}

let app = await launch();
let nodeId;
let projectId;
let beforeRestart;
const screenshot = path.join(run, 'checklist.png');
try {
  const page = await app.firstWindow();
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Shoot checklist');
  await button(page, 'Create project').click();
  await button(page, 'Add checklist').click();
  await expect(page.getByText('1 objects · 0 links')).toBeVisible();
  ({ space: { projectId, nodes: [{ id: nodeId }] } } = value(await invoke(page, 'view')));
  await button(page, 'Open Checklist').press('Enter');
  for (const task of ['Set key light', 'Check white balance']) {
    await plain(page).getByLabel('New task').fill(task);
    await button(plain(page), 'Add task').click();
    await expect(plain(page).getByRole('checkbox', { name: task })).toBeVisible();
  }
  await plain(page).getByLabel('New group').fill('Lighting');
  await button(plain(page), 'Add group').click();
  for (const task of ['Set key light', 'Check white balance']) {
    await plain(page).getByLabel('Group for ' + task).selectOption({ label: 'Lighting' });
    await expect(grouped(page).getByRole('checkbox', { name: task })).toBeVisible();
    await grouped(page).getByRole('checkbox', { name: task }).click();
    await expect(grouped(page).getByRole('checkbox', { name: task })).toBeChecked();
  }
  const query = { projectId, nodeId, offset: 0, limit: 1 };
  const original = value(await invoke(page, 'checklistCompletions', query));
  assert.equal(original.total, 2);
  const next = value(await invoke(page, 'checklistCompletions', { ...query, offset: original.nextOffset, sourceRevision: original.sourceRevision }));
  assert.equal(next.nextOffset, null);
  assert.notEqual(original.rows[0].completion.revision, next.rows[0].completion.revision);
  for (const row of [...original.rows, ...next.rows]) {
    assert.match(row.completion.occurredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  const focused = grouped(page).getByRole('listitem').filter({ has: page.getByRole('checkbox', { name: 'Check white balance' }) });
  await focused.focus();
  await focused.press('Alt+ArrowUp');
  await expect(grouped(page).getByRole('checkbox').first()).toHaveAccessibleName('Check white balance');
  await expect(focused).toBeFocused();
  const stale = await invoke(page, 'checklistCompletions', { ...query, sourceRevision: original.sourceRevision });
  assert.equal(stale.error.code, 'SOURCE_CHANGED');
  beforeRestart = value(await invoke(page, 'checklistCompletions', { ...query, limit: 10 }));
  assert.deepEqual(beforeRestart.rows, [...next.rows, ...original.rows]);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw new Error('Checklist capture is empty');
    return image.toPNG().toString('base64');
  });
  await writeFile(screenshot, Buffer.from(png, 'base64'));
} finally {
  await app.close();
}

app = await launch();
let result;
try {
  const page = await app.firstWindow();
  await button(page, 'Projects').click();
  await button(page, 'Shoot checklist').click();
  await button(page, 'Fit all').click();
  await page.locator('.react-flow__node[data-id="' + nodeId + '"]').dblclick();
  await expect(grouped(page).getByRole('checkbox').first()).toHaveAccessibleName('Check white balance');
  await expect(grouped(page).getByRole('checkbox', { name: 'Set key light' })).toBeChecked();
  assert.deepEqual(value(await invoke(page, 'checklistCompletions', { projectId, nodeId, offset: 0, limit: 10 })), beforeRestart);

  const note = randomUUID();
  const targetId = randomUUID();
  const left = randomUUID();
  const right = randomUUID();
  const position = { x: 350, y: 40 };
  await apply(page, { kind: 'add', node: { id: note, label: 'Reference checklist', position,
    content: { kind: 'note', text: 'Lighting\n- [x] Check white balance\n- [ ] Set key light' } } });
  await apply(page, { kind: 'add', node: { id: targetId, label: 'Compare lists', position,
    content: { kind: 'portal', plainId: randomUUID(), typeId: 'forge.comparison', schemaVersion: 1, payload: '{}' } } });
  for (const [source, id] of [[nodeId, left], [note, right]]) {
    await apply(page, { kind: 'connect', id, source: { nodeId: source, portId: 'text' }, target: { nodeId: targetId, portId: 'sources' } });
  }
  const target = { projectId, targetId };
  const linked = await Promise.all([left, right].map(linkId => invoke(page, 'linkedText', { ...target, linkId }).then(value)));
  assert.equal(linked[0].text, 'Lighting\n- [x] Check white balance\n- [x] Set key light');
  const selections = [left, right].map((linkId, index) => ({ linkId, sourceRevision: linked[index].sourceRevision, versionId: null }));
  result = value(await invoke(page, 'runComparison', {
    ...target, operationId: randomUUID(), baseRevision: value(await invoke(page, 'view')).revision,
    left: selections[0], right: selections[1],
  }));
  assert.equal(result.mode, 'text');
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
} finally {
  await app.close();
}

console.log(JSON.stringify({
  outcome: 'PASS', run, screenshot, keyboardReorder: true, focusPreserved: true,
  groupsAndCompletionPersisted: true, paginatedCompletionRecords: true, staleCursorRejected: true,
  compareChecklistText: true, resultDigest: result.resultDigest,
  coreSha256: createHash('sha256').update(await readFile(path.join(root, '.local/bin/forge-core.exe'))).digest('hex'),
}, null, 2));

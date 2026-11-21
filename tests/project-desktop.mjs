import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const evidence = path.join(root, '.local', 'qualification');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'project-'));
const project = path.join(run, 'Desktop project');
await mkdir(project);

async function pointPicker(app, projectDirectory) {
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, projectDirectory);
}

async function launch(profile = 'browser') {
  const app = await _electron.launch({
    executablePath,
    args: [root],
    env: {
      ...process.env,
      FORGE_QUALIFICATION: '1',
      FORGE_QUALIFICATION_DATA: path.join(run, profile),
    },
  });
  await pointPicker(app, project);
  return app;
}

const title = 'Forge — Проверка проекта';
const note = 'Заметка: остаётся после перезапуска.';
const view = page => page.evaluate(() => window.forge.project.view());
const canvasStatus = page => page.locator('.statusbar span[role=status]');
let app = await launch();
try {
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill(title);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('1 objects · 0 links')).toBeVisible();
  await page.getByRole('button', { name: 'Open Untitled note' }).click();
  await expect(page.getByRole('heading', { name: 'Untitled note' })).toBeFocused();
  await page.getByLabel('Note text').fill(note);
  await page.getByRole('button', { name: 'Back to Space' }).click();
  await expect(page.getByLabel('Note text')).toHaveValue(note);
  await expect(page.getByText('Save or discard the note changes before leaving.')).toBeVisible();
  const beforeSave = await view(page);
  const externalWriter = new DatabaseSync(path.join(project, '.forge', 'workspace.sqlite'));
  try {
    externalWriter.exec('BEGIN IMMEDIATE');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect(canvasStatus(page)).toContainText('Save failed');
    await expect(page.getByLabel('Note text')).toHaveValue(note);
    assert.deepEqual(await view(page), beforeSave);
  } finally {
    externalWriter.close();
  }
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('.statusbar span[role=status]')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Back to Space' }).click();
  await expect(page.getByRole('button', { name: 'Open Untitled note' })).toBeFocused();
  await expect(page.getByText(note)).toBeVisible();
  await page.getByRole('button', { name: 'Add checklist' }).click();
  await page.getByRole('button', { name: 'Open Checklist' }).press('Enter');
  const plain = page.getByRole('region', { name: 'Checklist tasks' });
  await plain.getByLabel('New task').fill('Prepare the script');
  await plain.getByRole('button', { name: 'Add task' }).click();
  await plain.getByRole('checkbox', { name: 'Prepare the script' }).click();
  await expect(plain.getByRole('checkbox', { name: 'Prepare the script' })).toBeChecked();
  await expect(plain.getByText('1 of 1 complete')).toBeVisible();
  await expect(page.locator('.statusbar span[role=status]')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Back to Space' }).press('Enter');
  const beforeMove = await page.evaluate(() => window.forge.project.view());
  assert.equal(beforeMove.ok, true);
  const checklist = beforeMove.value.space.nodes.find(node => node.content.kind === 'portal');
  const card = page.locator('.react-flow__node[data-id="' + checklist.id + '"]');
  const bounds = await card.boundingBox();
  assert(bounds);
  await page.mouse.move(bounds.x + 50, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 146, bounds.y + 84, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.forge.project.view());
    return current.value?.revision;
  }).toBe(beforeMove.value.revision + 1);
  const afterMove = await view(page);
  assert.equal(afterMove.ok, true);
  assert.notDeepEqual(afterMove.value.space.nodes.find(node => node.id === checklist.id).position, checklist.position);

  const noteId = afterMove.value.space.nodes.find(node => node.content.kind === 'note').id;
  await page.locator('.react-flow__node[data-id="' + noteId + '"]').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await expect(canvasStatus(page)).toHaveText('Saved');
  const grouped = await view(page);
  assert.equal(grouped.value.space.groups.length, 1);
  assert.deepEqual(new Set(grouped.value.space.groups[0].members), new Set([noteId, checklist.id]));
  const ungroup = page.getByRole('button', { name: 'Ungroup', exact: true });
  await expect(ungroup).toBeEnabled();
  await ungroup.press('ArrowRight');
  await expect.poll(async () => (await view(page)).value?.revision).toBe(grouped.value.revision + 1);
  const movedGroup = await view(page);
  for (const node of movedGroup.value.space.nodes) {
    const prior = grouped.value.space.nodes.find(item => item.id === node.id);
    assert.deepEqual(node.position, { x: prior.position.x + 16, y: prior.position.y });
  }
  await expect(canvasStatus(page)).toHaveText('Saved');
  const groupedBounds = await card.boundingBox();
  assert(groupedBounds);
  await page.mouse.move(groupedBounds.x + 44, groupedBounds.y + 19);
  await page.mouse.down();
  await page.mouse.move(groupedBounds.x + 108, groupedBounds.y + 51, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await view(page)).value?.revision).toBe(movedGroup.value.revision + 1);
  const draggedGroup = await view(page);
  const displacements = draggedGroup.value.space.nodes.map(node => {
    const prior = movedGroup.value.space.nodes.find(item => item.id === node.id);
    return { x: node.position.x - prior.position.x, y: node.position.y - prior.position.y };
  });
  assert.notDeepEqual(displacements[0], { x: 0, y: 0 });
  assert.deepEqual(displacements[0], displacements[1]);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(canvasStatus(page)).toHaveText('Copied 2 objects');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByText('4 objects · 0 links')).toBeVisible();
  const pasted = await view(page);
  const originals = new Set([noteId, checklist.id]);
  const copies = pasted.value.space.nodes.filter(node => !originals.has(node.id));
  assert.equal(copies.length, 2);
  assert.equal(pasted.value.space.groups.length, 2);
  const originalPlain = grouped.value.space.nodes.find(node => node.id === checklist.id).content;
  const copyPlain = copies.find(node => node.content.kind === 'portal').content;
  assert.notEqual(copyPlain.plainId, originalPlain.plainId);
  assert.notEqual(JSON.parse(copyPlain.payload).items[0].id, JSON.parse(originalPlain.payload).items[0].id);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  const initial = await view(page);
  assert.equal(initial.value.canRedo, true);

  const second = await launch('second-browser');
  try {
    const otherPage = await second.firstWindow();
    await otherPage.getByRole('button', { name: 'Projects', exact: true }).click();
    await otherPage.getByRole('button', { name: 'Open project' }).click();
    await expect(otherPage.getByRole('alert')).toContainText('open in another writer');
  } finally {
    await second.close();
  }
  await app.close();

  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const recent = page.getByRole('region', { name: 'Recent projects' });
  await recent.getByRole('button', { name: title }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText(note)).toBeVisible();
  await expect(page.getByText('1 of 1 complete')).toBeVisible();
  const restored = await page.evaluate(() => window.forge.project.view());
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.value.space, initial.value.space);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByText('4 objects · 0 links')).toBeVisible();
  assert.deepEqual((await view(page)).value.space, pasted.value.space);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  const latest = await view(page);
  const manifest = JSON.parse(await readFile(path.join(project, '.forge', 'project.json'), 'utf8'));
  assert.equal(manifest.projectId, restored.value.space.projectId);
  const renameTitle = 'Переименованный проект';
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Current project name').fill(renameTitle);
  await page.getByRole('button', { name: 'Rename project' }).click();
  await expect(recent.getByRole('button', { name: renameTitle })).toBeVisible();
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  const history = page.getByRole('region', { name: 'Project history' });
  await expect(history.getByText('Renamed project', { exact: false })).toBeVisible();
  await history.getByRole('button', { name: 'Restore revision ' + latest.value.revision, exact: true }).click();
  await history.getByRole('button', { name: 'Restore as new revision' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const afterRestore = await page.evaluate(() => window.forge.project.view());
  assert.equal(afterRestore.ok, true);
  assert.equal(afterRestore.value.revision, latest.value.revision + 2);
  assert.deepEqual(afterRestore.value.space, initial.value.space);
  await app.close();

  const moved = path.join(run, 'Moved project');
  await rename(project, moved);
  await mkdir(project);
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill('Different project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Different project' })).toBeVisible();
  // Recreate a stale recent item as a previous installation would leave it.
  await app.close();
  const catalogPath = path.join(run, 'browser', 'recent-projects.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.projects.push({ id: manifest.projectId, directory: project, title, openedAt: new Date().toISOString() });
  await writeFile(catalogPath, JSON.stringify(catalog));
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: title }).click();
  await expect(page.getByRole('alert')).toContainText('belongs to a different project');
  await pointPicker(app, moved);
  await page.getByRole('button', { name: 'Open project' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const relocated = await page.evaluate(() => window.forge.project.view());
  assert.deepEqual(relocated, afterRestore);
  await page.locator('.react-flow__node[data-id="' + checklist.id + '"]').click({ button: 'right' });
  await page.getByRole('complementary', { name: 'Object actions' }).getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('0 objects · 0 links')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('2 objects · 0 links')).toBeVisible();
  assert.deepEqual((await view(page)).value.space, afterRestore.value.space);
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    platform: process.platform,
    createThroughUi: true,
    editThroughUi: true,
    draftProtectedOnNavigation: true,
    draftAndRevisionSurviveDatabaseBusy: true,
    focusReturnsToSelection: true,
    secondWriterRejected: true,
    groupKeyboardMovePersisted: true,
    groupPointerDragPersisted: true,
    pastedGroupRegeneratedIds: true,
    redoAvailableAfterRestart: true,
    contextArchiveAndUndo: true,
    checklistPortalRoundTrip: true,
    movedPortalPositionPersisted: true,
    reopenAfterRestart: true,
    recentProjectAfterRestart: true,
    renameUpdatesCatalog: true,
    restoreCreatesNewRevision: true,
    relocatedProjectReopened: true,
    staleCatalogDoesNotOpenDifferentProject: true,
    stableIds: true,
    revision: afterRestore.value.revision,
  }, null, 2) + '\n');
  console.log('Desktop project persistence PASS. Evidence: ' + run);
} finally {
  await app.close();
}

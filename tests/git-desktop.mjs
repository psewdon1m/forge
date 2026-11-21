import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import executablePath from 'electron';

const workspace = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const qualification = path.join(workspace, '.local', 'qualification');
await mkdir(qualification, { recursive: true });
const run = await mkdtemp(path.join(qualification, 'git-'));
const repository = path.join(run, 'Fixture worktree');
const project = path.join(run, 'Original project');
const archive = path.join(run, 'project.zip');
const file = path.join(repository, 'changes.txt');
await Promise.all([mkdir(repository), mkdir(project)]);

function git(...args) {
  return execFileSync('git', ['--no-pager', '-c', 'user.name=Native fixture', '-c', 'user.email=native@example.invalid',
    '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '-C', repository, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
git('init', '--initial-branch=main');
await writeFile(file, 'base\n');
await writeFile(path.join(repository, '.gitattributes'), '*.txt filter=forge-fixture\n');
git('add', '--', '.gitattributes', 'changes.txt');
git('commit', '-m', 'Base commit');
git('switch', '-c', 'feature');
await writeFile(file, 'feature\n');
git('add', '--', 'changes.txt');
git('commit', '-m', 'Feature commit');
const featureHead = git('rev-parse', 'HEAD');
git('switch', 'main');
const baseHead = git('rev-parse', 'HEAD');
const hook = '#!/bin/sh\nprintf triggered > forge-hook-marker\nexit 23\n';
await Promise.all([
  writeFile(path.join(repository, '.git', 'hooks', 'pre-commit'), hook),
  writeFile(path.join(repository, '.git', 'hooks', 'post-checkout'), hook),
]);
git('config', '--local', 'filter.forge-fixture.clean', 'false');
git('config', '--local', 'filter.forge-fixture.smudge', 'false');
git('config', '--local', 'filter.forge-fixture.required', 'true');
git('config', '--local', 'diff.external', 'false');

async function launch(profile) {
  const app = await _electron.launch({
    executablePath, args: [workspace], timeout: 20_000,
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile) },
  });
  await app.evaluate(({ dialog }, archive) => {
    globalThis.gitSelection = [];
    dialog.showOpenDialog = async () => ({ canceled: !globalThis.gitSelection.length, filePaths: globalThis.gitSelection });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: archive });
  }, archive);
  return app;
}
const select = (app, ...files) => app.evaluate((_, files) => { globalThis.gitSelection = files; }, files);
const button = (area, name) => area.getByRole('button', { name, exact: true });
const request = (page, method, input) => page.evaluate(([method, input]) => window.forge.project[method](input), [method, input]);
function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const view = page => request(page, 'view').then(value);

async function openCard(page, nodeId) {
  await button(page, 'Fit all').click();
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).dblclick();
  const panel = page.getByRole('region', { name: 'Git', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

let app;
try {
  app = await launch('Default profile');
  let page = await app.firstWindow();
  await select(app, project);
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Git qualification');
  await button(page, 'Create project').click();
  await button(page, 'Add Git').click();
  await expect(page.getByText('1 objects · 0 links')).toBeVisible();
  const original = await view(page);
  const gitNode = original.space.nodes.find(node => node.content.typeId === 'forge.git');
  const card = { projectId: original.space.projectId, nodeId: gitNode.id };
  let panel = await openCard(page, card.nodeId);
  await expect(button(panel, 'Choose repository')).toBeEnabled();
  assert.equal(value(await request(page, 'gitRead', { ...card, repository })), null, 'IPC cannot take a repository from the renderer');
  await select(app, project);
  await button(panel, 'Choose repository').click();
  await expect(panel.getByRole('alert')).toContainText('own .git directory');
  await select(app, repository);
  await button(panel, 'Choose repository').click();
  await expect(panel.getByRole('heading', { name: 'Fixture worktree' })).toBeVisible();
  await expect(panel.getByText('Working tree is clean.')).toBeVisible();
  assert.equal(value(await request(page, 'gitRead', card)).head, baseHead);
  assert.equal((await request(page, 'gitRead', { ...card, projectId: randomUUID() })).error.code, 'PROJECT_CHANGED');

  await writeFile(file, 'approved from Forge\n');
  await button(panel, 'Refresh').click();
  const row = panel.getByRole('listitem').filter({ hasText: 'changes.txt' });
  await expect(row).toBeVisible();
  await panel.getByLabel('Local branches').selectOption('feature');
  await expect(button(panel, 'Switch branch')).toBeDisabled();
  const dirty = value(await request(page, 'gitRead', card));
  await button(row, 'Unstaged diff').click();
  await expect(panel.getByRole('region', { name: 'Selected diff' })).toContainText('+approved from Forge');
  await button(row, 'Stage').click();
  await expect(row).toContainText('Staged · modified');
  await button(row, 'Staged diff').click();
  await expect(panel.getByRole('region', { name: 'Selected diff' })).toContainText('-base');
  const stale = await request(page, 'gitMutate', { ...card, action: { kind: 'stage', path: 'changes.txt' }, revision: dirty.revision });
  assert.equal(stale.error.code, 'GIT_CHANGED');
  await button(row, 'Unstage').click();
  await expect(row).toContainText('Unstaged · modified');
  await button(row, 'Stage').click();
  await expect(row).toContainText('Staged · modified');
  await panel.getByLabel('Author name').fill('Forge fixture');
  await panel.getByLabel('Author email').fill('forge@example.invalid');
  await panel.getByLabel('Commit message').fill('Reviewed commit');
  await button(panel, 'Commit staged changes').click();
  await expect(panel.getByText('Reviewed commit')).toBeVisible();
  await expect(panel.getByText('Working tree is clean.')).toBeVisible();
  const committedHead = git('rev-parse', 'HEAD');
  assert.notEqual(committedHead, baseHead);
  assert.equal(git('log', '-1', '--format=%s%n%an%n%ae'), 'Reviewed commit\nForge fixture\nforge@example.invalid');
  assert.equal(git('show', 'HEAD:changes.txt'), 'approved from Forge');

  await panel.getByLabel('Local branches').selectOption('feature');
  await button(panel, 'Switch branch').click();
  await expect(panel.getByText('feature · ' + featureHead.slice(0, 12))).toBeVisible();
  assert.equal(await readFile(file, 'utf8'), 'feature\n');
  await assert.rejects(readFile(path.join(repository, 'forge-hook-marker')), { code: 'ENOENT' });

  git('config', '--local', '--unset', 'filter.forge-fixture.required');
  git('config', '--local', '--unset', 'filter.forge-fixture.clean');
  git('config', '--local', '--unset', 'filter.forge-fixture.smudge');
  assert.throws(() => git('merge', 'main'), error => error.status === 1);
  const conflicted = await readFile(file, 'utf8');
  assert.match(conflicted, /<<<<<<< HEAD/);
  await button(panel, 'Refresh').click();
  await expect(panel.getByText('Resolve merge conflicts', { exact: false })).toBeVisible();
  const conflictState = value(await request(page, 'gitRead', card));
  assert.equal(conflictState.conflicted, true);
  const indexPath = path.join(repository, '.git', 'index');
  const conflictIndex = await readFile(indexPath);
  const blocked = await request(page, 'gitMutate', { ...card, action: { kind: 'switchBranch', branch: 'main' }, revision: conflictState.revision });
  assert.equal(blocked.error.code, 'GIT_CONFLICT');
  assert.equal(await readFile(file, 'utf8'), conflicted);
  assert.deepEqual(await readFile(indexPath), conflictIndex);
  assert.equal(git('rev-parse', 'HEAD'), featureHead);
  git('merge', '--abort');

  const after = await view(page);
  assert.equal(after.revision, original.revision, 'external Git writes do not create Forge timeline revisions');
  assert.deepEqual(JSON.parse(after.space.nodes.find(node => node.id === card.nodeId).content.payload), {});
  value(await request(page, 'exportBackup', { projectId: card.projectId, baseRevision: after.revision }));
  await app.close();
  app = await launch('Default profile');
  page = await app.firstWindow();
  await select(app, project);
  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  panel = await openCard(page, card.nodeId);
  await expect(panel.getByText('feature · ' + featureHead.slice(0, 12))).toBeVisible();
  await expect(panel.getByText('Working tree is clean.')).toBeVisible();
  await app.close();

  app = await launch('Restored profile');
  page = await app.firstWindow();
  await select(app, archive);
  const inspected = value(await request(page, 'inspectBackup'));
  await select(app, run);
  const restored = value(await request(page, 'restoreBackup', inspected.token));
  await select(app, path.join(run, restored.folder));
  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  await expect(page.getByRole('heading', { name: 'Git qualification', exact: true })).toBeVisible();
  const recovered = await view(page);
  const recoveredGit = recovered.space.nodes.find(node => node.content.typeId === 'forge.git');
  assert.notEqual(recovered.space.projectId, card.projectId);
  panel = await openCard(page, recoveredGit.id);
  await expect(button(panel, 'Choose repository')).toBeEnabled();
  assert.equal(value(await request(page, 'gitRead', { projectId: recovered.space.projectId, nodeId: recoveredGit.id })), null);
  await select(app, repository);
  await button(panel, 'Choose repository').click();
  await expect(panel.getByText('feature · ' + featureHead.slice(0, 12))).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 720));
  assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  await button(panel, 'Disconnect').click();
  await expect(button(panel, 'Choose repository')).toBeEnabled();
  assert.equal(git('rev-parse', 'HEAD'), featureHead);

  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    outcome: 'PASS', baseHead, committedHead, featureHead,
    nativeDirectorySelectionRequired: true, phaseDiffsVerified: true, staleRevisionDenied: true,
    stageUnstageCommitAndCheckoutVerified: true, localHookAndFiltersBypassed: true,
    conflictIndexAndWorktreePreserved: true, reopenedSameDeviceBinding: true,
    restoredCardRequiredNewBinding: true, disconnectedWithoutMutatingRepository: true, narrowPanelFits: true,
  }, null, 2) + '\n');
  console.log('Git Desktop PASS. Evidence: ' + run);
} finally {
  await app?.close();
}

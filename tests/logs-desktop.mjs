import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const runCommand = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'logs-ui-'));
const profile = path.join(run, 'Profile');
const syntheticPath = 'Synthetic_private_path';
const syntheticTitle = 'Synthetic project private title';
const syntheticText = '{"headers":{"Authorization":"Bearer synthetic-fake-token"},"source":"https://example.invalid/?api_key=extract-me"}';
const project = path.join(run, syntheticPath);
const exportPath = path.join(run, 'diagnostics.zip');
await mkdir(project);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: { ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profile },
  });
  await app.evaluate(({ dialog }, paths) => {
    globalThis.cancelDiagnosticDownload = true;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.project] });
    dialog.showSaveDialog = async (_owner, options) => {
      if (!options.defaultPath?.startsWith('forge-logs-')) throw new Error('Expected a diagnostics archive picker');
      return { canceled: globalThis.cancelDiagnosticDownload, filePath: paths.exportPath };
    };
  }, { project, exportPath });
  return app;
}

function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}

let app = await launch();
let projectId;
let correlationId;
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project name').fill(syntheticTitle);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: syntheticTitle })).toBeVisible();
  projectId = value(await page.evaluate(() => window.forge.project.view())).space.projectId;
  const edit = {
    projectId, operationId: randomUUID(), baseRevision: 9,
    change: { kind: 'add', node: { id: randomUUID(), label: 'Private note', position: { x: 0, y: 0 },
      content: { kind: 'note', text: syntheticText } } },
  };
  const rejected = await page.evaluate(input => window.forge.project.apply(input), edit);
  assert.equal(rejected.error.code, 'REVISION_CONFLICT');
  correlationId = rejected.error.correlationId;
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  value(await page.evaluate(input => window.forge.project.apply(input), { ...edit, baseRevision: 0 }));
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local diagnostics' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Save Space change REVISION_CONFLICT' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project history' })).toBeVisible();
  assert.equal(value(await page.evaluate(() => window.forge.project.exportLogs())), null);
  assert(!(await readdir(run)).includes('diagnostics.zip'));
  await app.evaluate(() => { globalThis.cancelDiagnosticDownload = false; });
  await page.getByRole('button', { name: 'Download archived logs' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Diagnostics archive saved.' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Export diagnostics archive', exact: true }).first()).toBeVisible();
  const savedBytes = await readFile(exportPath);
  const duplicate = await page.evaluate(() => window.forge.project.exportLogs());
  assert.equal(duplicate.error.code, 'EXPORT_EXISTS');
  assert.deepEqual(await readFile(exportPath), savedBytes);
  const lock = new DatabaseSync(path.join(profile, 'diagnostics', 'audit.sqlite'));
  try {
    lock.exec('BEGIN IMMEDIATE');
    const saved = await page.evaluate(id => window.forge.project.apply({
      projectId: id, operationId: crypto.randomUUID(), baseRevision: 1,
      change: { kind: 'renameProject', title: 'Committed while diagnostics were locked' },
    }), projectId);
    assert.equal(value(saved).revision, 2);
    await expect(page.getByRole('alert').filter({ hasText: 'Some diagnostics could not be recorded' })).toBeVisible();
  } finally {
    lock.close();
  }
} finally {
  await app.close();
}

const archive = await readFile(exportPath);
const archiveSha256 = createHash('sha256').update(archive).digest('hex');
const membersOutput = await runCommand('tar.exe', ['-tf', exportPath]);
const members = membersOutput.stdout.trim().split(/\r?\n/);
assert.deepEqual(members, ['events.jsonl', 'errors.json', 'README.txt', 'raw/runtime-01.jsonl', 'manifest.json']);
const member = async name => (await runCommand('tar.exe', ['-xOf', exportPath, name])).stdout;
const manifest = JSON.parse(await member('manifest.json'));
const events = (await member('events.jsonl')).trim().split(/\r?\n/).map(JSON.parse);
const errors = JSON.parse(await member('errors.json'));
assert.equal(manifest.format, 'forge-diagnostics');
assert.equal(manifest.update, undefined, 'An unmanaged runtime has no verified release context');
assert.equal(manifest.auditEvents, events.length);
assert.equal(manifest.errorEvents, errors.length);
assert.equal(errors.length, 1);
assert.equal(errors[0].error.code, 'REVISION_CONFLICT');
assert.equal(errors[0].correlationId, correlationId);
assert.equal(errors[0].targetId, projectId);
assert.equal(errors[0].error.stackTrace, null);
assert(events.some(row => row.action === 'logs-export' && row.outcome === 'canceled'));
assert(!events.some(row => row.action === 'logs-export' && row.outcome === 'success'));
const runtime = JSON.parse((await member('raw/runtime-01.jsonl')).trim());
assert.equal(runtime.action, 'start');
for (const forbidden of [syntheticPath, syntheticTitle, 'Private note', 'synthetic-fake-token', 'extract-me', 'example.invalid']) {
  assert(!archive.includes(Buffer.from(forbidden)), 'unexpected retained value ' + forbidden);
}

const sqlitePath = path.join(profile, 'diagnostics', 'audit.sqlite');
const database = new DatabaseSync(sqlitePath);
try {
  const occurredAt = Date.now();
  const template = {
    occurredAt,
    observation: { action: 'apply', outcome: 'success', projectId, errorCode: null },
  };
  const insert = database.prepare('INSERT INTO events(occurred_at,payload) VALUES (?,?)');
  database.exec('BEGIN');
  for (let i = 0; i < 204; i++) {
    insert.run(occurredAt, JSON.stringify({
      ...template, id: randomUUID(), observation: { ...template.observation, correlationId: randomUUID() },
    }));
  }
  database.exec('COMMIT');
} finally {
  database.close();
}
app = await launch();
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page.getByRole('row')).toHaveCount(201);
  const initial = value(await page.evaluate(() => window.forge.project.logsPage(null)));
  const older = value(await page.evaluate(cursor => window.forge.project.logsPage(cursor), initial.older));
  assert(older.rows.some(row => row.correlationId === correlationId));
  assert.equal(new Set([...initial.rows, ...older.rows].map(row => row.id)).size, initial.rows.length + older.rows.length);
  await page.getByRole('button', { name: 'Load older events' }).click();
  await expect(page.getByRole('cell', { name: 'Save Space change REVISION_CONFLICT' })).toBeVisible();
  await page.getByRole('button', { name: 'Latest events' }).click();
  await expect(page.getByRole('row')).toHaveCount(201);
  const stream = page.getByLabel('Retained diagnostics');
  const scrollTop = await stream.evaluate(list => { list.scrollTop = 200; return list.scrollTop; });
  assert(scrollTop > 0);
  value(await page.evaluate(() => window.forge.project.open()));
  await expect(page.getByRole('button', { name: 'Show new events' })).toBeVisible();
  assert.equal(await stream.evaluate(list => list.scrollTop), scrollTop);
  await page.getByRole('button', { name: 'Show new events' }).click();
  await expect(page.getByRole('row').nth(1)).toContainText('Open project');
} finally {
  await app.close();
}

console.log(JSON.stringify({
  outcome: 'PASS', run, archiveSha256, zipMembers: members, retainedErrorCorrelated: true,
  firstExportExcludedItsOwnOutcome: true, forbiddenInputExcluded: true, reopenedAudit: true,
  pagingWithoutDuplicate: true, firstPageSize: 200, existingArchivePreserved: true, liveScrollAnchorPreserved: true,
  auditWriteFailureVisible: true, projectWriteSurvived: true,
}, null, 2));

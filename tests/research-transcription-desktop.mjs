import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const qualification = path.join(root, '.local', 'qualification');
await mkdir(qualification, { recursive: true });
const real = process.argv.includes('--real');
const run = await mkdtemp(path.join(qualification, real ? 'transcription-real-' : 'transcription-ui-'));
const project = path.join(run, 'Project');
const archive = path.join(run, 'transcript.zip');
const recording = path.join(run, 'voice-note.wav');
const previousText = 'Earlier verified observation.';
await mkdir(project);

function silentWav() {
  const samples = 16_000 * 2;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

if (real && !process.env.FORGE_TRANSCRIPTION_REAL_WAV) throw new Error('Set FORGE_TRANSCRIPTION_REAL_WAV to the synthetic speech fixture.');
const wav = real ? await readFile(process.env.FORGE_TRANSCRIPTION_REAL_WAV) : silentWav();
const wavSha = createHash('sha256').update(wav).digest('hex');
await writeFile(recording, wav);

let requestMode = 'normal';
let requestCount = 0;
let interruptedRequests = 0;
let providerPort = Number(process.env.FORGE_TRANSCRIPTION_REAL_PORT);
const fixtureReply = { task: 'transcribe', language: 'english', duration: 2, segments: [
  { start: 0.1, end: 0.7, text: 'Fixture transcript with a marker.' },
  { start: 0.8, end: 1.5, text: '<img> literal provider text.' },
] };
let server;
if (!real) {
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/inference');
      const boundary = /boundary=(.+)$/.exec(request.headers['content-type'])?.[1];
      assert.ok(boundary);
      const parts = [];
      for await (const part of request) parts.push(part);
      const input = Buffer.concat(parts);
      const fileHeader = Buffer.from('filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n');
      const headerOffset = input.indexOf(fileHeader);
      assert.ok(headerOffset >= 0);
      const bodyOffset = headerOffset + fileHeader.length;
      assert.deepEqual(input.subarray(bodyOffset, input.indexOf(Buffer.from(`\r\n--${boundary}--`), bodyOffset)), wav);
      const fields = input.subarray(0, headerOffset).toString('utf8');
      assert.match(fields, /name="language"\r\n\r\nen\r\n/);
      assert.match(fields, /name="response_format"\r\n\r\nverbose_json\r\n/);
      assert.doesNotMatch(fields, /voice-note|Speech fixture|authorization/i);
      requestCount++;
      if (requestMode === 'hang') {
        response.on('close', () => { interruptedRequests++; });
        return;
      }
      if (requestMode === 'refuse') { response.writeHead(503).end(); return; }
      const result = requestMode === 'malformed' ? { ...fixtureReply, segments: [{ start: 0, end: 4, text: 'Invalid timestamp' }] } : fixtureReply;
      response.end(JSON.stringify(result));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  providerPort = server.address().port;
}
assert.ok(Number.isInteger(providerPort) && providerPort > 0 && providerPort <= 65535);

async function launch(profile) {
  const app = await _electron.launch({ executablePath, args: [root], timeout: 25_000, env: { ...process.env,
    FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile),
    FORGE_QUALIFICATION_TRANSCRIPTION_PORT: String(providerPort),
  } });
  await app.evaluate(({ dialog }, archive) => {
    globalThis.speechPicker = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.speechPicker });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: archive });
  }, archive);
  return app;
}
const button = (area, name) => area.getByRole('button', { name, exact: true });
const picker = (app, files) => app.evaluate((_, paths) => { globalThis.speechPicker = paths; }, files);
const call = (page, method, input) => page.evaluate(([method, input]) => window.forge.project[method](input), [method, input]);
const value = reply => { assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.value; };
const view = page => call(page, 'view').then(value);
async function edit(page, change) {
  const snapshot = await view(page);
  return call(page, 'apply', { projectId: snapshot.space.projectId, baseRevision: snapshot.revision, operationId: randomUUID(), change });
}
const document = (snapshot, id) => JSON.parse(snapshot.space.nodes.find(node => node.id === id).content.payload);

async function openProject(app, page, directory) {
  await picker(app, [directory]);
  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  await expect(page.getByRole('heading', { name: 'Speech fixture', exact: true })).toBeVisible();
}

async function openResearch(page, id) {
  await button(page, 'Fit all').click();
  await page.locator(`.react-flow__node[data-id="${id}"]`).dblclick();
  const panel = page.getByRole('region', { name: 'Research sources', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

let app;
try {
  app = await launch('Original profile');
  let page = await app.firstWindow();
  await picker(app, [project]);
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Speech fixture');
  await button(page, 'Create project').click();
  await button(page, 'Add Research').click();
  await picker(app, [recording]);
  await button(page, 'Import files').click();
  await expect(page.getByText('Imported 1 of 1 files', { exact: true })).toBeVisible();
  const initial = await view(page);
  const { projectId } = initial.space;
  const targetId = initial.space.nodes.find(node => node.content.typeId === 'forge.research').id;
  const file = initial.space.nodes.find(node => node.content.asset?.format === 'wav');
  const linkId = randomUUID();
  value(await edit(page, { kind: 'moveSelection', placements: [
    { id: targetId, position: { x: 64, y: 96 } }, { id: file.id, position: { x: 352, y: 96 } },
  ] }));
  value(await edit(page, { kind: 'connect', id: linkId, source: { nodeId: file.id, portId: 'files' }, target: { nodeId: targetId, portId: 'sources' } }));
  value(await edit(page, { kind: 'editResearch', id: targetId, action: { kind: 'capture', linkId, assetId: null } }));
  const capture = document(await view(page), targetId).sources[0];
  const sourceId = capture.id;
  value(await edit(page, { kind: 'editResearch', id: targetId, action: { kind: 'setTranscript', sourceId,
    revision: capture.activeRevision, segments: [{ startMs: 0, endMs: 400, text: previousText }] } }));
  const oldVersion = document(await view(page), targetId).sources[0].activeRevision;

  await openProject(app, page, project);
  const panel = await openResearch(page, targetId);
  const searchStatus = panel.getByRole('status', { name: 'Research search index' });
  await expect(searchStatus).toHaveText('2 saved versions indexed');
  await button(panel, 'Transcribe automatically').click();
  const automatic = panel.getByRole('region', { name: 'Automatic transcription', exact: true });
  await automatic.getByLabel('Transcription provider').selectOption('whisper.cpp');
  await automatic.getByLabel('Transcription language').selectOption('en');
  await button(automatic, 'Review recording').click();
  await expect(automatic.getByText(file.content.asset.versionId, { exact: true })).toBeVisible();
  await expect(automatic.getByText(oldVersion, { exact: true })).toBeVisible();
  await expect(automatic.getByText(wavSha, { exact: true })).toBeVisible();
  await expect(button(automatic, 'Send recording')).toBeDisabled();
  assert.equal(requestCount, 0);
  await automatic.getByLabel('Allow sending this WAV').check();
  await button(automatic, 'Send recording').click();
  const preview = automatic.getByRole('region', { name: 'Transcript preview', exact: true });
  const recognized = real ? /the green marker shows the reference light/i : /Fixture transcript with a marker/;
  await expect(preview.getByText(recognized)).toBeVisible({ timeout: 25_000 });
  if (!real) await expect(preview.getByText(/<img> literal provider text/)).toBeVisible();
  await button(preview, 'Save automatic transcript').click();
  await expect(automatic).toBeHidden();
  await expect(searchStatus).toHaveText('3 saved versions indexed');
  const original = document(await view(page), targetId).sources[0];
  const saved = original.versions.find(version => version.revision === original.activeRevision);
  assert.notEqual(saved.revision, oldVersion);
  assert.equal(saved.material.asset.sha256, wavSha);
  assert.equal(saved.material.transcriptOrigin.provider, 'whisper.cpp');
  assert.equal(saved.material.transcriptOrigin.sourceRevision, oldVersion);
  assert.equal(saved.material.transcriptOrigin.requestedLanguage, 'en');
  assert.ok(saved.material.transcriptOrigin.completedAt > 0);
  assert.match(saved.material.transcriptOrigin.responseSha256, /^[a-f0-9]{64}$/);
  assert.ok(saved.material.segments.every(segment => segment.endMs > segment.startMs && segment.endMs <= saved.material.durationMs));
  assert.equal(original.versions.find(version => version.revision === oldVersion).material.segments[0].text, previousText);

  const target = { projectId, targetId };
  const input = { ...target, sourceId, revision: saved.revision, provider: 'whisper.cpp', language: 'en' };
  const review = async () => value(await call(page, 'transcriptionReview', input));
  const start = (planId, approve = true) => call(page, 'transcriptionStart', { ...target, planId, approve });
  if (!real) {
    assert.equal(requestCount, 1);
    const protectedReview = await review();
    assert.equal((await start(protectedReview.id, false)).error.code, 'TRANSCRIPTION_APPROVAL_REQUIRED');
    value(await edit(page, { kind: 'editResearch', id: targetId, action: { kind: 'setProjectOnly', sourceId, projectOnly: true } }));
    assert.equal((await start(protectedReview.id)).error.code, 'MODEL_CONTEXT_PROTECTED');
    value(await edit(page, { kind: 'editResearch', id: targetId, action: { kind: 'setProjectOnly', sourceId, projectOnly: false } }));
    assert.equal(requestCount, 1);

    requestMode = 'hang';
    const canceled = await review();
    const pending = start(canceled.id);
    await expect.poll(() => requestCount).toBe(2);
    value(await call(page, 'transcriptionCancel', { ...target, planId: canceled.id }));
    assert.equal((await pending).error.code, 'TRANSCRIPTION_CANCELED');
    await expect.poll(() => interruptedRequests).toBe(1);
    assert.equal((await start(canceled.id)).error.code, 'TRANSCRIPTION_REVIEW_REQUIRED');
    requestMode = 'refuse';
    assert.equal((await start((await review()).id)).error.code, 'TRANSCRIPTION_UNAVAILABLE');
    requestMode = 'malformed';
    assert.equal((await start((await review()).id)).error.code, 'TRANSCRIPTION_INVALID');
    requestMode = 'normal';
    const accepted = value(await start((await review()).id));
    const forged = await edit(page, { kind: 'editResearch', id: targetId, action: { kind: 'setProviderTranscript', sourceId,
      revision: saved.revision, segments: accepted.segments, origin: accepted.origin } });
    assert.equal(forged.error.code, 'FORBIDDEN');
    value(await edit(page, { kind: 'disconnect', id: linkId }));
    const saveRequest = { ...target, baseRevision: (await view(page)).revision, operationId: randomUUID(), resultId: accepted.id };
    assert.equal((await call(page, 'transcriptionSave', saveRequest)).error.code, 'SOURCE_NOT_FOUND');
    assert.equal((await call(page, 'transcriptionReview', input)).error.code, 'SOURCE_NOT_FOUND');
  }

  const before = await view(page);
  assert.deepEqual(document(before, targetId).sources[0], original);
  value(await call(page, 'exportBackup', { projectId, baseRevision: before.revision }));
  await app.close();
  app = await launch('Restored profile');
  page = await app.firstWindow();
  await picker(app, [archive]);
  const inspection = value(await call(page, 'inspectBackup'));
  await picker(app, [run]);
  const restored = value(await call(page, 'restoreBackup', inspection.token));
  await openProject(app, page, path.join(run, restored.folder));
  const after = await view(page);
  assert.notEqual(after.space.projectId, projectId);
  assert.deepEqual(document(before, targetId), document(after, targetId));
  const restoredPanel = await openResearch(page, targetId);
  await expect(restoredPanel.getByRole('status', { name: 'Research search index' })).toHaveText('3 saved versions indexed');
  await expect(restoredPanel.getByText(/Transcript by whisper\.cpp/)).toBeVisible();
  await expect(restoredPanel.getByRole('region', { name: 'Saved audio and transcript' }).getByText(recognized)).toBeVisible();

  const details = { outcome: 'PASS', engine: real ? 'real whisper.cpp on Windows' : 'isolated whisper.cpp HTTP fixture',
    audioSha256: wavSha, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    providerResponseSha256: saved.material.transcriptOrigin.responseSha256, minutes: saved.material.durationMs / 60_000,
    segmentCount: saved.material.segments.length, recognizedTextVerified: true, explicitConsent: true,
    newVersionAndPreviousPreserved: true, restoredProvenance: true,
    ...(real ? {} : { exactWavTransport: true, protectedBeforeSend: true, canceledTransport: true, providerErrorsPreservedHistory: true,
      consumedApprovalReplayRejected: true, blockedForgedSave: true, blockedSaveAfterRevocation: true }),
  };
  await writeFile(path.join(run, 'observations.json'), JSON.stringify(details, null, 2) + '\n');
  console.log('Research automatic transcription PASS. Evidence: ' + run);
} finally {
  await app?.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

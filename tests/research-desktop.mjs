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
const run = await mkdtemp(path.join(parent, 'research-ui-'));
const project = path.join(run, 'Project');
const textPath = path.join(run, 'interview.md');
const imagePath = path.join(run, 'reference.png');
const pdfPath = path.join(run, 'field-guide.pdf');
const scanPath = path.join(run, 'scan.pdf');
const brokenPath = path.join(run, 'broken.pdf');
const longPath = path.join(run, 'long.pdf');
const audioPath = path.join(run, 'interview.wav');
const malformedWav = path.join(run, 'broken.wav');
const archive = path.join(run, 'research.zip');
const original = 'Shot notes\r\nСвет 🎞 и noon\r\nKeep these source bytes.';
const quote = 'Свет 🎞 и noon';
await mkdir(project);
await writeFile(textPath, original);

function pdf(pages) {
  const ids = pages.map((_, index) => `${4 + 2 * index} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${ids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  for (const stream of pages) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let document = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(document.length).padStart(10, '0')} 00000 n \n`);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  return document + `xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${document.length}\n%%EOF\n`;
}

function wav(milliseconds) {
  const rate = 8000;
  const block = 2;
  const dataBytes = Math.round(rate * milliseconds / 1000) * block;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * block, 28);
  bytes.writeUInt16LE(block, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}

const pdfQuote = 'Light remains constant.';
const scanText = 'Handwritten note from the printed card.';
const graphic = 'q 0.4 g 72 600 100 40 re f Q';
const audioQuote = 'Первая реплика 🎙';
const replacementQuote = 'Уточнённая реплика';
const originalAudio = wav(2400);
const badAudio = Buffer.from(originalAudio);
badAudio.writeUInt16LE(3, 20);
await Promise.all([
  writeFile(pdfPath, pdf([`BT /F1 12 Tf 72 720 Td (${pdfQuote}) Tj ET`, 'BT /F1 12 Tf 72 720 Td (Second page of the field guide.) Tj ET'])),
  writeFile(scanPath, pdf([graphic])),
  writeFile(brokenPath, '%PDF-1.4\nIncomplete document.\n%%EOF\n'),
  writeFile(longPath, pdf(Array(257).fill(graphic))),
  writeFile(audioPath, originalAudio),
  writeFile(malformedWav, badAudio),
]);

async function launch(profile) {
  const app = await _electron.launch({ executablePath, args: [root], env: {
    ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: path.join(run, profile),
  } });
  await app.evaluate(({ dialog }, zip) => {
    globalThis.researchPicker = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: globalThis.researchPicker });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: zip });
  }, archive);
  (await app.firstWindow()).setDefaultTimeout(12_000);
  return app;
}

const button = (area, name) => area.getByRole('button', { name, exact: true });
const panel = page => page.getByRole('region', { name: 'Research sources' });
const call = (page, name, data) => page.evaluate(([name, input]) => window.forge.project[name](input), [name, data]);
function value(reply) { assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.value; }
const view = page => call(page, 'view').then(value);
const picker = (app, files) => app.evaluate((_, files) => { globalThis.researchPicker = files; }, files);
const content = (view, id) => JSON.parse(view.space.nodes.find(node => node.id === id).content.payload);

async function change(page, change) {
  const { space, revision } = await view(page);
  return call(page, 'apply', { projectId: space.projectId, baseRevision: revision, operationId: randomUUID(), change });
}

async function openProject(app, page, path) {
  await picker(app, [path]);
  await button(page, 'Projects').click();
  await button(page, 'Open project').click();
  await expect(page.getByRole('heading', { name: 'Field study', exact: true })).toBeVisible();
}

async function openResearch(page, id) {
  await button(page, 'Fit all').click();
  await page.locator(`.react-flow__node[data-id="${id}"]`).dblclick();
  await expect(panel(page)).toBeVisible();
}

async function selectSnippet(field, text) {
  await field.focus();
  await field.evaluate((element, snippet) => {
    const start = element.value.indexOf(snippet);
    if (start < 0) throw new Error('Expected the snippet in the saved source');
    element.setSelectionRange(start, start + snippet.length - 1);
  }, text);
  await field.press('Shift+ArrowRight');
}

let app = await launch('Original profile');
try {
  let page = await app.firstWindow();
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = '#168035';
    context.fillRect(0, 0, 16, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(imagePath, Buffer.from(image, 'base64'));
  await picker(app, [project]);
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Field study');
  await button(page, 'Create project').click();
  await button(page, 'Add Research').click();
  await button(page, 'Add Site').click();
  await button(page, 'Add Gallery').click();
  await picker(app, [textPath, imagePath, pdfPath, scanPath, brokenPath, longPath, audioPath, malformedWav]);
  await button(page, 'Import files').click();
  await expect(page.getByText('Imported 7 of 8 files')).toBeVisible();
  await expect(page.getByText('Use a mono or stereo PCM WAV file with a readable header')).toBeVisible();

  const first = await view(page);
  const research = first.space.nodes.find(node => node.content.typeId === 'forge.research');
  const site = first.space.nodes.find(node => node.content.typeId === 'forge.site');
  const gallery = first.space.nodes.find(node => node.content.typeId === 'forge.gallery');
  const md = first.space.nodes.find(node => node.content.asset?.format === 'md');
  const photo = first.space.nodes.find(node => node.content.asset?.format === 'png');
  const [guide, scan, malformed, longer, audio] = [pdfPath, scanPath, brokenPath, longPath, audioPath].map(input =>
    first.space.nodes.find(node => node.content.asset?.name === path.basename(input)));
  const placements = [research, site, gallery, md, photo, guide, scan, malformed, longer, audio].map((node, index) => ({
    id: node.id, position: { x: 48 + (index % 3) * 224, y: 48 + Math.floor(index / 3) * 224 },
  }));
  value(await change(page, { kind: 'moveSelection', placements }));
  const reference = { url: 'https://example.test/references', title: 'Reference page', quote: 'Published reference excerpt.' };
  value(await change(page, { kind: 'editSite', id: site.id, site: { reference } }));
  value(await change(page, { kind: 'editGallery', id: gallery.id, items: [{ assetId: photo.content.asset.assetId, versionId: photo.content.asset.versionId }] }));
  const linked = [[md, 'text'], [site, 'quote'], [gallery, 'images'], [guide, 'files'], [scan, 'files'],
    [malformed, 'files'], [longer, 'files'], [audio, 'files']].map(([node, port]) => ({
    kind: 'connect', id: randomUUID(), source: { nodeId: node.id, portId: port }, target: { nodeId: research.id, portId: 'sources' },
  }));
  for (const request of linked) value(await change(page, request));

  await openProject(app, page, project);
  await openResearch(page, research.id);
  const board = panel(page);
  async function capture(index, sources) {
    await board.getByLabel('Linked source').selectOption(linked[index].id);
    if (index === 2) await board.getByLabel('Linked image').selectOption(photo.content.asset.assetId);
    await button(board, 'Capture source').click();
    await expect.poll(async () => content(await view(page), research.id).sources.length).toBe(sources);
  }
  await capture(0, 1);
  const saved = board.getByLabel('Saved source text');
  await expect(saved).toHaveValue(original.replaceAll('\r\n', '\n'));
  await selectSnippet(saved, quote);
  await button(board, 'Save selected text as citation').click();
  await expect(board.locator('figure blockquote')).toHaveText(quote);
  const pinned = content(await view(page), research.id);
  assert.equal(pinned.citations[0].start, Buffer.byteLength('Shot notes\r\n'));
  assert.equal(pinned.citations[0].end - pinned.citations[0].start, Buffer.byteLength(quote));

  await capture(1, 2);
  await button(board, 'Reference page').click();
  await expect(board.getByText(reference.url, { exact: true })).toBeVisible();
  await expect(saved).toHaveValue(reference.quote);
  await capture(2, 3);
  await button(board, 'reference.png').click();
  const preview = board.getByRole('img', { name: 'reference.png' });
  await expect.poll(() => preview.evaluate(image => image.naturalWidth)).toBe(16);

  await button(board, 'Add manual source').click();
  await board.getByLabel('Source title').fill('Observation log');
  await board.getByLabel('Source text', { exact: true }).fill('Recorded under diffuse light.');
  await button(board, 'Save source version').click();
  await expect(button(board, 'Observation log')).toBeVisible();
  await board.getByLabel('Search saved sources').fill('diffuse');
  await expect(button(board, 'interview.md')).toHaveCount(0);
  await expect(button(board, 'Observation log')).toBeVisible();
  await board.getByLabel('Search saved sources').clear();

  await capture(3, 5);
  await button(board, 'field-guide.pdf').click();
  await expect(board.getByText('Extracted from the PDF text layer', { exact: true })).toBeVisible();
  await expect(saved).toHaveValue(`${pdfQuote}\nSecond page of the field guide.`);
  let recorded = content(await view(page), research.id);
  assert.deepEqual(recorded.sources[4].versions[0].material.asset, guide.content.asset);
  assert.equal(recorded.sources[4].versions[0].material.extraction, 'textLayerV1');
  await selectSnippet(saved, pdfQuote);
  await button(board, 'Save selected text as citation').click();
  await expect(board.locator('figure blockquote')).toHaveText([quote, pdfQuote]);
  const pdfCitation = content(await view(page), research.id).citations[1];
  assert.equal(pdfCitation.revision, recorded.sources[4].versions[0].revision);
  assert.deepEqual([pdfCitation.start, pdfCitation.end], [0, Buffer.byteLength(pdfQuote)]);

  const beforePdfFailures = await view(page);
  for (const [index, code] of [[4, 'NO_EXTRACTABLE_TEXT'], [5, 'PDF_UNREADABLE'], [6, 'PDF_LIMIT']]) {
    const rejected = await change(page, { kind: 'editResearch', id: research.id, action: {
      kind: 'capture', linkId: linked[index].id, assetId: null,
    } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, code, JSON.stringify(rejected));
    assert.equal((await view(page)).revision, beforePdfFailures.revision);
  }
  const wrongVersion = await change(page, { kind: 'editResearch', id: research.id, action: {
    kind: 'capture', linkId: linked[4].id, assetId: null, pdfText: { versionId: guide.content.asset.versionId, text: scanText },
  } });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.error.code, 'SOURCE_CHANGED');
  assert.equal((await view(page)).revision, beforePdfFailures.revision);
  await board.getByLabel('Linked source').selectOption(linked[4].id);
  await button(board, 'Capture source').click();
  await expect(page.getByText(/This PDF has no extractable text/)).toBeVisible();
  await button(board, 'Enter PDF text').click();
  await board.getByLabel('PDF text', { exact: true }).fill(scanText);
  await button(board, 'Save source version').click();
  await button(board, 'scan.pdf').click();
  await expect(board.getByText('Manually entered PDF text', { exact: true })).toBeVisible();
  await expect(saved).toHaveValue(scanText);
  recorded = content(await view(page), research.id);
  assert.deepEqual(recorded.sources[5].versions[0].material.asset, scan.content.asset);
  assert.equal(recorded.sources[5].versions[0].material.extraction, 'manual');

  await capture(7, 7);
  await button(board, 'interview.wav').click();
  const player = board.getByLabel('Saved recording', { exact: true });
  await expect.poll(() => player.evaluate(element => element.duration, undefined, { timeout: 3000 })).toBeCloseTo(2.4, 3);
  await expect(player).toHaveAttribute('src', /^forge-audio:\/\/listen\//);
  await player.evaluate(element => element.play());
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  await player.evaluate(element => { element.pause(); element.currentTime = 0; });
  const beforeTranscript = await view(page);
  const audioSource = content(beforeTranscript, research.id).sources[6];
  assert.deepEqual(audioSource.versions[0].material, {
    kind: 'audio', asset: audio.content.asset, durationMs: 2400, segments: [],
  });
  assert.equal(audio.content.asset.sha256, createHash('sha256').update(originalAudio).digest('hex'));
  const wrongProject = await call(page, 'researchAudio', {
    projectId: randomUUID(), targetId: research.id, sourceId: audioSource.id, revision: audioSource.activeRevision,
  });
  assert.equal(wrongProject.ok, false);
  assert.equal(wrongProject.error.code, 'PROJECT_CHANGED');
  for (const segments of [[{ startMs: 0, endMs: 2401, text: audioQuote }],
    [{ startMs: 0, endMs: 1500, text: audioQuote }, { startMs: 1000, endMs: 2000, text: 'Overlap' }]]) {
    const rejected = await change(page, { kind: 'editResearch', id: research.id, action: {
      kind: 'setTranscript', sourceId: audioSource.id, revision: audioSource.activeRevision, segments,
    } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'TRANSCRIPT_TIMESTAMPS');
    assert.equal((await view(page)).revision, beforeTranscript.revision);
  }
  await button(board, 'Add transcript').click();
  const firstSegment = board.getByRole('group', { name: 'Segment 1' });
  await firstSegment.getByLabel('Start (seconds)').fill('0.35');
  await firstSegment.getByLabel('End (seconds)').fill('1.1');
  await firstSegment.getByLabel('Segment text').fill(audioQuote);
  await button(board, 'Add segment').click();
  const secondSegment = board.getByRole('group', { name: 'Segment 2' });
  await secondSegment.getByLabel('Start (seconds)').fill('1.2');
  await secondSegment.getByLabel('End (seconds)').fill('2.1');
  await secondSegment.getByLabel('Segment text').fill('Second passage.');
  await button(board, 'Save transcript').click();
  await expect(saved).toHaveValue(`${audioQuote}\nSecond passage.`);
  await button(board, '00:00:01.200–00:00:02.100').click();
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(1.2, 2);
  await selectSnippet(saved, audioQuote);
  await button(board, 'Save selected text as citation').click();
  await expect(board.locator('figure blockquote')).toHaveText([quote, pdfQuote, audioQuote]);
  await expect(board.locator('figure').filter({ hasText: audioQuote }).locator('figcaption')).toContainText('00:00:00.350–00:00:01.100');

  await board.getByLabel('New conclusion').fill('Use the same lighting for the comparison.');
  await board.getByRole('checkbox', { name: quote }).check();
  await button(board, 'Save conclusion').click();
  await expect(board.getByText('Current source context', { exact: true })).toBeVisible();

  await button(board, 'Edit transcript').click();
  await firstSegment.getByLabel('Segment text').fill(replacementQuote);
  await button(board, 'Save transcript').click();
  await expect(saved).toHaveValue(`${replacementQuote}\nSecond passage.`);
  await expect(board.getByText('Based on an earlier source context', { exact: true })).toBeVisible();
  await expect(board.locator('figure blockquote')).toHaveText([quote, pdfQuote, audioQuote]);

  const existingView = await view(page);
  const invalid = await change(page, { kind: 'editResearch', id: research.id, action: {
    kind: 'cite', sourceId: pinned.citations[0].sourceId, revision: pinned.citations[0].revision,
    start: pinned.citations[0].start + 1, end: pinned.citations[0].end,
  } });
  assert.equal(invalid.ok, false);
  assert.equal((await view(page)).revision, existingView.revision);
  const oversized = await change(page, { kind: 'editResearch', id: research.id, action: {
    kind: 'manual', sourceId: null, title: 'Oversized', text: 'x'.repeat(65_537),
  } });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'RESEARCH_LIMIT');
  assert.equal((await view(page)).revision, existingView.revision);

  await button(page, 'Back to Space').click();
  const replacement = 'Revised interview.\nContext replaced.';
  value(await call(page, 'editTextAsset', { projectId: first.space.projectId, nodeId: md.id,
    versionId: md.content.asset.versionId, operationId: randomUUID(), baseRevision: (await view(page)).revision, text: replacement }));
  await openProject(app, page, project);
  await openResearch(page, research.id);
  await expect(board.getByText('Source changed', { exact: true })).toBeVisible();
  await expect(board.getByText('Based on an earlier source context', { exact: true })).toBeVisible();
  await button(board, 'Capture latest version').click();
  await expect(saved).toHaveValue(replacement);
  await expect(board.locator('figure blockquote')).toHaveText([quote, pdfQuote, audioQuote]);
  await board.getByLabel('Search saved sources').fill('Keep these source bytes');
  await button(board, 'interview.md').click();
  await expect(saved).toHaveValue(original.replaceAll('\r\n', '\n'));
  await board.getByLabel('Search saved sources').clear();
  await board.getByLabel('Saved source version').selectOption(pinned.citations[0].revision);
  await expect(saved).toHaveValue(original.replaceAll('\r\n', '\n'));

  await button(page, 'Back to Space').click();
  value(await change(page, { kind: 'disconnect', id: linked[0].id }));
  value(await change(page, { kind: 'disconnect', id: linked[7].id }));
  const rejected = await change(page, { kind: 'editResearch', id: research.id, action: { kind: 'refresh', sourceId: pinned.sources[0].id } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'SOURCE_NOT_FOUND');
  const before = await view(page);
  value(await call(page, 'exportBackup', { projectId: before.space.projectId, baseRevision: before.revision }));
  await app.close();

  app = await launch('Restore profile');
  page = await app.firstWindow();
  await picker(app, [archive]);
  const inspection = value(await call(page, 'inspectBackup'));
  await picker(app, [run]);
  const restored = value(await call(page, 'restoreBackup', inspection.token));
  await openProject(app, page, path.join(run, restored.folder));
  const restoredView = await view(page);
  assert.notEqual(restoredView.space.projectId, before.space.projectId);
  assert.deepEqual(content(restoredView, research.id), content(before, research.id));
  await openResearch(page, research.id);
  await expect(panel(page).getByText('Link unavailable', { exact: true })).toHaveCount(2);
  await expect(panel(page).locator('figure blockquote')).toHaveText([quote, pdfQuote, audioQuote]);
  await expect(panel(page).getByText('Based on an earlier source context', { exact: true })).toBeVisible();
  await button(panel(page), 'field-guide.pdf').click();
  await expect(panel(page).getByLabel('Saved source text')).toHaveValue(`${pdfQuote}\nSecond page of the field guide.`);
  await panel(page).getByRole('button', { name: /^interview\.wav/ }).click();
  await expect(panel(page).getByLabel('Saved source text')).toHaveValue(`${replacementQuote}\nSecond passage.`);
  await expect.poll(() => panel(page).getByLabel('Saved recording').evaluate(element => element.duration, undefined, { timeout: 3000 })).toBeCloseTo(2.4, 3);
  await writeFile(path.join(run, 'research-panel.txt'), await panel(page).ariaSnapshot());
  await button(page, 'Back to Space').click();
  await button(page, 'Documentation').click();
  await expect(page.getByRole('heading', { name: 'Research sources and citations' })).toBeVisible();
  await writeFile(path.join(run, 'observations.json'), JSON.stringify({
    outcome: 'PASS', projectRevision: before.revision, sources: 7,
    archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    originalUtf8CitationPreserved: true, crlfAndUnicodeSelection: true, imagePreviewVerified: true,
    savedSiteQuote: true, manualSearch: true, historicalSearch: true, earlierConclusionMarked: true,
    inaccessibleLinkRejected: true, invalidCitationAndQuotaRejected: true, restoredIntoNewProject: true,
    documentationRendered: true,
    pdfTextLayer: true, pdfCitationPinned: true, scanNoExtractableText: true, malformedPdfRejected: true, pageQuotaEnforced: true,
    manualPdfVersionVerified: true, pdfTextRestored: true,
    pcmWavVerified: true, malformedWavRejected: true, audioPlayed: true, audioSeek: true, detachedAudioRestored: true,
    transcriptTimestampChecks: true, transcriptHistory: true, audioCitationTimestamp: true, unrelatedProjectRejected: true,
  }, null, 2) + '\n');
  console.log('Research revision, citation and ZIP restore PASS. Evidence: ' + run);
} finally {
  await app.close();
}

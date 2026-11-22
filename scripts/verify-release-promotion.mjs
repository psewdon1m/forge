import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { bootstrapName, canonical, commitFormat, fileDigest, packageName, releaseBase, signedDeliveryFiles, stableVersion } from './release-format.mjs';
import { gate, isPublicEvidenceUrl, loadCatalog, validatePublicPart12Report, verifyFirstReleaseApplicability } from './release-policy.mjs';

const repository = 'psewdon1m/forge';
const apiPath = `repos/${repository}`;
const apiRoot = `https://api.github.com/${apiPath}`;
const assetsHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const sha256 = /^[0-9a-f]{64}$/;
const runIdFormat = /^[1-9]\d{0,19}$/;
const publicationRows = new Map([
  ['REL-12', 'pre-publication'], ['REL-09', 'release-ready'], ['TRUST-03', 'release-ready'],
]);
const checks = [
  'verifiedFirstInstall', 'offlineLaunchAndProject', 'stableIgnoresPrerelease', 'compatibleUpdateFromSettings',
  'backupAndRestore', 'automaticRollback', 'interruptedActivationRecovery', 'manualRollback',
  'interruptedRollbackRecovery', 'registeredDocxAndPdfEditors',
];
const windowsFields = new Set(['schemaVersion', 'profile', 'platform', 'windowsBuild', 'releaseId', 'tag',
  'revision', 'packageSha256', 'setupSha256', 'checks']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

export function validateVerification(verification, qualified, runId) {
  const { tag, version, commit } = qualified;
  if (!stableVersion.test(version) || tag !== 'forge-v' + version || !commitFormat.test(commit) || !runIdFormat.test(runId) ||
      verification?.outcome !== 'PASS' || verification.tag !== tag || verification.revision !== commit || verification.runId !== runId ||
      !sha256.test(verification.publicKeySha256 ?? '') || !sha256.test(verification.signedReportSha256 ?? '')) {
    throw new Error('Signed verification does not match the qualified tag and run');
  }
  const zip = packageName(version);
  const setup = bootstrapName(version);
  const inventory = signedDeliveryFiles(version);
  const { checkedFiles, fileSizes } = verification;
  if (!checkedFiles || !fileSizes || Object.keys(checkedFiles).length !== inventory.length || Object.keys(fileSizes).length !== inventory.length ||
      inventory.some(name => !sha256.test(checkedFiles[name] ?? '') || !Number.isSafeInteger(fileSizes[name]) || fileSizes[name] < 1) ||
      checkedFiles[zip] !== verification.packageSha256 || checkedFiles[setup] !== verification.setupSha256 || fileSizes['forge-release.sig'] !== 64) {
    throw new Error('Signed verification has an invalid asset inventory');
  }
  return { setup, inventory };
}

export function validatePromotionReports(report, signedReport, verification, ids, phase = 'release-ready', noStablePredecessor = false) {
  if (digest(signedReport) !== verification.signedReportSha256) throw new Error('Signed-phase report digest changed');
  const signed = JSON.parse(signedReport);
  gate(signed, verification, ids, { phase: 'signed-artifact', noStablePredecessor });
  validatePublicPart12Report(signed);
  const rows = new Map(signed.checks.map(row => [row.id, row]));
  gate(report, verification, ids, { phase, noStablePredecessor });
  validatePublicPart12Report(report);
  for (const row of report.checks) {
    const approved = rows.get(row.id);
    const mayComplete = approved.status === 'UNKNOWN' && publicationRows.get(row.id) === approved.deferred_until &&
      (phase === 'release-ready' || approved.deferred_until === phase);
    if (!mayComplete && canonical(row) !== canonical(approved)) throw new Error('Previously approved Part 12 row changed: ' + row.id);
  }
}

export function validateWindowsQualification(receipt, verification, releaseId) {
  if (!Number.isSafeInteger(releaseId) || releaseId < 1 || receipt?.schemaVersion !== 1 || !['standard-user', 'clean-standard-user'].includes(receipt.profile) ||
      receipt.platform !== 'windows-x64' || !Number.isSafeInteger(receipt.windowsBuild) || receipt.windowsBuild < 22000 ||
      receipt.releaseId !== releaseId || receipt.tag !== verification.tag || receipt.revision !== verification.revision ||
      receipt.packageSha256 !== verification.packageSha256 || receipt.setupSha256 !== verification.setupSha256) {
    throw new Error('Windows qualification does not match the exact immutable release and Windows standard-user profile');
  }
  if (Object.keys(receipt).some(key => !windowsFields.has(key)) ||
      Object.keys(receipt.checks ?? {}).some(key => !checks.includes(key))) {
    throw new Error('Unexpected fields in the public Windows qualification');
  }
  for (const name of checks) {
    const check = receipt.checks?.[name];
    if (check?.status !== 'PASS' || !isPublicEvidenceUrl(check.evidence) || Object.keys(check).length !== 2) {
      throw new Error('Missing Windows standard-user qualification: ' + name);
    }
  }
}

export function validatePublicRelease(release, verification, { prerelease, releaseId }) {
  if (!Number.isSafeInteger(releaseId) || releaseId < 1 || release?.id !== releaseId || release.tag_name !== verification.tag ||
      release.draft !== false || release.prerelease !== prerelease || release.immutable !== true ||
      !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('Public release is not the expected immutable ' + (prerelease ? 'prerelease' : 'Stable release'));
  }
  const names = Object.keys(verification.checkedFiles);
  if (!Array.isArray(release.assets) || release.assets.length !== names.length) throw new Error('Public asset inventory differs from the approved delivery');
  const listed = new Map(release.assets.map(asset => [asset.name, asset]));
  for (const name of names) {
    const asset = listed.get(name);
    if (asset?.state !== 'uploaded' || asset.digest !== 'sha256:' + verification.checkedFiles[name] || asset.size !== verification.fileSizes[name]) {
      throw new Error('Public release metadata differs for ' + name);
    }
  }
}

async function githubJson(endpoint, request) {
  const response = await request(apiRoot + endpoint, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('Public GitHub API returned HTTP ' + response.status + ' for ' + endpoint);
  return response.json();
}

async function readPublicRelease(verification, state, request) {
  const [release, main, tagged] = await Promise.all([
    githubJson('/releases/tags/' + verification.tag, request),
    state.prerelease !== false ? githubJson('/git/ref/heads/main', request) : null,
    githubJson('/commits/' + verification.tag, request),
  ]);
  if ((state.prerelease !== false && main?.object?.sha !== verification.revision) || tagged?.sha !== verification.revision) {
    throw new Error('Remote main or the release tag changed');
  }
  validatePublicRelease(release, verification, { ...state, prerelease: state.prerelease ?? (release?.prerelease === true) });
  return release;
}

async function fetchAsset(url, request) {
  const options = { redirect: 'manual', signal: AbortSignal.timeout(180_000) };
  let response = await request(url, options);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const target = URL.parse(response.headers.get('location') ?? '');
    if (!target || target.protocol !== 'https:' || target.username || target.password || target.port || target.hash || !assetsHosts.has(target.hostname)) {
      throw new Error('Unexpected redirect for a public release asset');
    }
    await response.body?.cancel();
    response = await request(target.href, options);
  }
  if (response.status !== 200 || !response.body) throw new Error('Public asset download failed, HTTP ' + response.status);
  return response.body;
}

async function verifyAsset(verification, name, request, output) {
  const source = await fetchAsset(`${releaseBase}/${verification.tag}/${name}`, request);
  const hash = createHash('sha256');
  const expected = verification.fileSizes[name];
  let size = 0;
  const file = output ? await open(output, 'wx') : null;
  try {
    for await (const bytes of source) {
      size += bytes.length;
      if (size > expected) throw new Error('Public asset exceeds its approved size: ' + name);
      hash.update(bytes);
      await file?.writeFile(bytes);
    }
  } finally {
    await file?.close();
  }
  if (size !== expected || hash.digest('hex') !== verification.checkedFiles[name]) throw new Error('Public asset bytes differ from the approval: ' + name);
}

function github(...args) {
  execFileSync('gh', args, { stdio: 'inherit', timeout: 120_000, windowsHide: true });
}

export async function verifyPublicDelivery(verification, qualified, runId, windows, directory, { request = fetch, gh = github } = {}) {
  const { setup, inventory } = validateVerification(verification, qualified, runId);
  validateWindowsQualification(windows, verification, windows?.releaseId);
  const state = { prerelease: true, releaseId: windows.releaseId };
  await readPublicRelease(verification, state, request);
  const localSetup = path.join(directory, setup);
  for (const name of inventory) await verifyAsset(verification, name, request, name === setup ? localSetup : undefined);
  gh('release', 'verify', verification.tag, '--repo', repository);
  gh('release', 'verify-asset', verification.tag, localSetup, '--repo', repository);
  return state.releaseId;
}

function assertWorkflowIdentity(verification) {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/tags/' + verification.tag ||
      process.env.GITHUB_SHA !== verification.revision || !runIdFormat.test(process.env.GITHUB_RUN_ID ?? '')) {
    throw new Error('Promotion must use the exact Forge release workflow ref');
  }
}

async function qualify(qualifiedFile, signedDirectory, output) {
  const qualified = await readJson(qualifiedFile);
  const verification = await readJson(path.join(signedDirectory, 'signed-verification.json'));
  const signedReport = await readFile(path.join(signedDirectory, 'signed-phase-report.json'));
  const { inputs } = await readJson(process.env.GITHUB_EVENT_PATH);
  assertWorkflowIdentity(verification);
  validateVerification(verification, qualified, inputs?.signed_run_id);
  if (typeof inputs.report !== 'string' || typeof inputs.windows_qualification !== 'string' ||
      inputs.report.length + inputs.windows_qualification.length > 65_535) throw new Error('Expected bounded Part 12 and Windows qualification evidence');
  const report = JSON.parse(inputs.report);
  const windows = JSON.parse(inputs.windows_qualification);
  const { ids } = await loadCatalog();
  const noStablePredecessor = await verifyFirstReleaseApplicability(report);
  validatePromotionReports(report, signedReport, verification, ids, 'release-ready', noStablePredecessor);
  await mkdir(output);
  const releaseId = await verifyPublicDelivery(verification, qualified, inputs.signed_run_id, windows, process.env.RUNNER_TEMP);
  await writeFile(path.join(output, 'known-problems-report.json'), inputs.report, { flag: 'wx' });
  await writeFile(path.join(output, 'windows-qualification.json'), inputs.windows_qualification, { flag: 'wx' });
  await writeFile(path.join(output, 'promotion-approval.json'), canonical({
    outcome: 'PASS', workflowRunId: process.env.GITHUB_RUN_ID, releaseId, qualified, verification,
    reportSha256: digest(inputs.report), windowsReceiptSha256: digest(inputs.windows_qualification),
  }), { flag: 'wx' });
}

function updateGitHubRelease(releaseId, payload) {
  return JSON.parse(execFileSync('gh', ['api', '--method', 'PATCH', `${apiPath}/releases/${releaseId}`, '--input', '-'], {
    input: canonical(payload), encoding: 'utf8', timeout: 60_000, windowsHide: true,
  }));
}

export async function publishApprovedRelease(receipt, { request = fetch, updateRelease = updateGitHubRelease } = {}) {
  const { verification, releaseId, workflowRunId, reportSha256 } = receipt;
  const runUrl = `https://github.com/${repository}/actions/runs/${workflowRunId}`;
  const evidence = `\n\nStable qualification: ${runUrl}\n\nPart 12 report SHA-256: \`${reportSha256}\`\n`;
  const state = { prerelease: false, releaseId };
  const release = await readPublicRelease(verification, { releaseId }, request);
  if (release.prerelease) {
    const result = updateRelease(releaseId, { prerelease: false, body: (release.body ?? '').trimEnd() + evidence });
    validatePublicRelease(result, verification, state);
  } else if (!release.body?.includes(evidence.trim())) {
    throw new Error('Release is already Stable without this workflow approval');
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const published = await readPublicRelease(verification, state, request);
      if (!published.body?.includes(evidence.trim())) throw new Error('The public release is missing its Stable evidence');
      return runUrl;
    } catch (error) {
      if (attempt >= 5) throw error;
      await setTimeout(2_000);
    }
  }
}

async function promote(directory) {
  const receipt = await readJson(path.join(directory, 'promotion-approval.json'));
  const { verification } = receipt;
  assertWorkflowIdentity(verification);
  validateVerification(verification, receipt.qualified, verification.runId);
  const report = await readFile(path.join(directory, 'known-problems-report.json'));
  const windows = await readFile(path.join(directory, 'windows-qualification.json'));
  if (receipt.outcome !== 'PASS' || receipt.workflowRunId !== process.env.GITHUB_RUN_ID ||
      receipt.reportSha256 !== digest(report) || receipt.windowsReceiptSha256 !== digest(windows)) throw new Error('Promotion approval does not match this workflow');
  const runUrl = await publishApprovedRelease(receipt);
  console.log(`Verified Stable release ${verification.tag} at ${runUrl}`);
}

async function checkBeforePublication(reportFile, signingReview, delivery) {
  const [report, signed, verification, { ids }] = await Promise.all([
    readJson(reportFile), readFile(path.join(signingReview, 'signed-phase-report.json')),
    readJson(path.join(signingReview, 'signed-verification.json')), loadCatalog(),
  ]);
  const { inventory } = validateVerification(verification, {
    tag: verification.tag, version: verification.tag?.slice(7), commit: verification.revision,
  }, verification.runId);
  const noStablePredecessor = await verifyFirstReleaseApplicability(report);
  validatePromotionReports(report, signed, verification, ids, 'pre-publication', noStablePredecessor);
  const entries = await readdir(delivery, { withFileTypes: true });
  if (entries.length !== inventory.length || entries.some(entry => !entry.isFile() || !inventory.includes(entry.name))) {
    throw new Error('Pre-publication delivery inventory differs from the signed review');
  }
  for (const name of inventory) {
    if (await fileDigest(path.join(delivery, name)) !== verification.checkedFiles[name]) {
      throw new Error('Pre-publication delivery changed: ' + name);
    }
  }
  console.log(`Verified Part 12 before publishing ${verification.tag}, ZIP SHA-256 ${verification.packageSha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'qualify' && args.length === 3) await qualify(...args);
  else if (mode === 'promote' && args.length === 1) await promote(...args);
  else if (mode === 'pre-publication' && args.length === 3) await checkBeforePublication(...args);
  else throw new Error('Use verify-release-promotion.mjs qualify QUALIFIED_JSON SIGNED_REVIEW OUTPUT, promote PROMOTION_APPROVAL or pre-publication REPORT SIGNED_REVIEW STAGED_DELIVERY');
}

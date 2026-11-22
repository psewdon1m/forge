import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapName, canonical, packageName, releaseBase, signedDeliveryFiles } from '../scripts/release-format.mjs';
import { draftReport } from '../scripts/release-policy.mjs';
import { completeSignedReport } from '../scripts/verify-signed-release.mjs';
import { publishApprovedRelease, validatePromotionReports, validatePublicRelease, validateWindowsQualification, verifyFirstReleaseApplicability, verifyPublicDelivery } from '../scripts/verify-release-promotion.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const version = '0.0.1';
const tag = 'forge-v' + version;
const revision = 'a'.repeat(40);
const qualified = { version, tag, commit: revision };
const runId = '1439';
const releaseId = 286;
const setup = bootstrapName(version);
const repo = 'psewdon1m/forge';
const names = signedDeliveryFiles(version);
const files = new Map(names.map(name => [name, name === 'forge-release.sig' ? Buffer.alloc(64, 12) : Buffer.from(name)]));
const checkedFiles = Object.fromEntries([...files].map(([name, bytes]) => [name, digest(bytes)]));
const fileSizes = Object.fromEntries([...files].map(([name, bytes]) => [name, bytes.length]));
const verification = {
  outcome: 'PASS', tag, revision, runId, publicKeySha256: '1'.repeat(64), signedReportSha256: '2'.repeat(64),
  packageSha256: checkedFiles[packageName(version)], setupSha256: checkedFiles[setup], checkedFiles, fileSizes,
};
const evidence = 'https://github.com/psewdon1m/forge/actions/runs/1440';
const windowsChecks = [
  'verifiedFirstInstall', 'offlineLaunchAndProject', 'stableIgnoresPrerelease', 'compatibleUpdateFromSettings',
  'backupAndRestore', 'automaticRollback', 'interruptedActivationRecovery', 'manualRollback',
  'interruptedRollbackRecovery', 'registeredDocxAndPdfEditors',
];
const windowsReceipt = () => ({
  schemaVersion: 1, profile: 'standard-user', platform: 'windows-x64', windowsBuild: 26100, releaseId, tag, revision,
  packageSha256: verification.packageSha256, setupSha256: verification.setupSha256,
  checks: Object.fromEntries(windowsChecks.map(name => [name, { status: 'PASS', evidence: evidence + '#' + name }])),
});
const publicRelease = () => ({
  id: releaseId, tag_name: tag, prerelease: true, draft: false, immutable: true, published_at: '2026-11-21T12:36:59Z',
  assets: names.map(name => ({ name, digest: 'sha256:' + checkedFiles[name], size: fileSizes[name], state: 'uploaded' })),
});

function publicRequest({ release = publicRelease(), commit = revision, bootstrap = files.get(setup), target = 'https://release-assets.githubusercontent.com/setup?download=1' } = {}) {
  return async (url, options) => {
    assert.equal(options.headers?.Authorization, undefined);
    if (url === `https://api.github.com/repos/${repo}/releases/tags/${tag}`) return Response.json(release);
    if (url === `https://api.github.com/repos/${repo}/git/ref/heads/main`) return Response.json({ object: { sha: revision } });
    if (url === `https://api.github.com/repos/${repo}/commits/${tag}`) return Response.json({ sha: commit });
    if (url === `${releaseBase}/${tag}/${setup}`) return Response.redirect(target, 302);
    if (url === target) return new Response(bootstrap);
    const name = url.slice(`${releaseBase}/${tag}/`.length);
    assert.equal(url, `${releaseBase}/${tag}/${name}`);
    assert.ok(files.has(name), `Unexpected public request ${url}`);
    return new Response(files.get(name));
  };
}

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-promote-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the public prerelease delivers every approved byte and both attestation checks use the exact tag and bootstrap', async t => {
  const directory = await scratch(t);
  const attestationCalls = [];
  const actual = await verifyPublicDelivery(verification, qualified, runId, windowsReceipt(), directory, {
    request: publicRequest(), gh: (...args) => attestationCalls.push(args),
  });
  assert.equal(actual, releaseId);
  const local = path.join(directory, setup);
  assert.deepEqual(await readFile(local), files.get(setup));
  assert.deepEqual(attestationCalls, [
    ['release', 'verify', tag, '--repo', repo], ['release', 'verify-asset', tag, local, '--repo', repo],
  ]);
});

test('promotion stops for different metadata, tag, asset bytes, redirect or denied attestation', async t => {
  const reject = error => (...args) => { throw new Error(error + ' ' + args.join(' ')); };
  const cases = [
    [{ release: { ...publicRelease(), immutable: false } }, /expected immutable prerelease/],
    [{ release: { ...publicRelease(), prerelease: false } }, /expected immutable prerelease/],
    [{ release: { ...publicRelease(), tag_name: 'forge-v0.0.2' } }, /expected immutable prerelease/],
    [{ commit: 'e'.repeat(40) }, /release tag changed/],
    [{ release: { ...publicRelease(), assets: publicRelease().assets.slice(1) } }, /asset inventory differs/],
    [{ bootstrap: Buffer.alloc(fileSizes[setup]) }, /asset bytes differ/],
    [{ bootstrap: Buffer.alloc(fileSizes[setup] + 1) }, /approved size/],
    [{ target: 'https://github.com/psewdon1m/forge/' }, /Unexpected redirect/],
    [{}, /attestation denied/],
  ];
  for (const [overrides, message] of cases) {
    await assert.rejects(verifyPublicDelivery(verification, qualified, runId, windowsReceipt(), await scratch(t), {
      request: publicRequest(overrides), gh: reject('attestation denied'),
    }), message);
  }
  const stable = { ...publicRelease(), prerelease: false };
  assert.doesNotThrow(() => validatePublicRelease(stable, verification, { prerelease: false, releaseId }));
  stable.assets[0].size++;
  assert.throws(() => validatePublicRelease(stable, verification, { prerelease: false, releaseId }), /metadata differs/);
});

test('qualification binds Windows standard-user results to the exact installed executable and package', () => {
  const accepted = windowsReceipt();
  assert.doesNotThrow(() => validateWindowsQualification(accepted, verification, releaseId));
  assert.doesNotThrow(() => validateWindowsQualification({ ...accepted, profile: 'clean-standard-user' }, verification, releaseId));
  for (const changed of [{ releaseId: releaseId + 1 }, { setupSha256: '3'.repeat(64) }, { packageSha256: '3'.repeat(64) },
    { windowsBuild: 19045 }, { profile: 'development' }]) {
    assert.throws(() => validateWindowsQualification({ ...accepted, ...changed }, verification, releaseId), /does not match/);
  }
  delete accepted.checks.manualRollback;
  assert.throws(() => validateWindowsQualification(accepted, verification, releaseId), /manualRollback/);
});

test('publication and external evidence close only the deferred Part 12 rows at their assigned phase', () => {
  const ids = new Set(['REL-01', 'REL-06', 'REL-09', 'REL-12', 'TRUST-03']);
  const complete = id => ({ id, status: 'PASS', reason: null, evidence: [evidence] });
  const report = draftReport(verification, ids);
  const deferred = (id, phase) => ({ id, status: 'UNKNOWN', deferred_until: phase, reason: 'Wait for exact published files.', evidence: [evidence] });
  report.checks = [complete('REL-01'), deferred('REL-06', 'signed-artifact'), deferred('REL-09', 'release-ready'),
    deferred('REL-12', 'pre-publication'), deferred('TRUST-03', 'release-ready')];
  const signed = completeSignedReport(report, verification, ids, evidence);
  const signedBytes = Buffer.from(canonical(signed));
  const verified = { ...verification, signedReportSha256: digest(signedBytes) };
  assert.equal(signed.checks.find(row => row.id === 'REL-06').status, 'PASS');
  assert.throws(() => validatePromotionReports(signed, signedBytes, verified, ids, 'pre-publication'), /Unresolved IDs: REL-12/);
  const beforePublication = { ...signed, checks: signed.checks.map(row => row.id === 'REL-12' ? complete(row.id) : row) };
  assert.doesNotThrow(() => validatePromotionReports(beforePublication, signedBytes, verified, ids, 'pre-publication'));
  const final = { ...signed, checks: signed.checks.map(row => row.status === 'UNKNOWN' ? complete(row.id) : row) };
  assert.doesNotThrow(() => validatePromotionReports(final, signedBytes, verified, ids));
  assert.throws(() => validatePromotionReports(signed, signedBytes, verified, ids), /REL-09, REL-12, TRUST-03/);
  assert.throws(() => validatePromotionReports(final, Buffer.from('changed report'), verified, ids), /digest changed/);
  final.checks[0].evidence = ['different evidence'];
  assert.throws(() => validatePromotionReports(final, signedBytes, verified, ids), /approved Part 12 row changed/);
});

test('the first-release exception requires live evidence that Forge has no published Stable predecessor', async () => {
  const report = { checks: [{ id: 'REL-12', status: 'N/A' }] };
  const read = releases => async url => {
    assert.equal(url, 'https://api.github.com/repos/psewdon1m/forge/releases?per_page=100&page=1');
    return Response.json(releases);
  };
  await verifyFirstReleaseApplicability(report, read([publicRelease()]));
  await assert.rejects(verifyFirstReleaseApplicability(report, read([{ ...publicRelease(), prerelease: false }])), /published Stable release/);
  await assert.rejects(verifyFirstReleaseApplicability(report, async () => new Response('', { status: 403 })), /HTTP 403/);
});

test('Stable promotion updates only the verified release and can retry after a successful write', async () => {
  const receipt = { verification, releaseId, workflowRunId: '1440', reportSha256: digest('final report') };
  let release = { ...publicRelease(), body: 'Original release notes.' };
  const request = (...args) => publicRequest({ release })(...args);
  let writeCount = 0;
  const updateRelease = (id, payload) => {
    assert.equal(id, releaseId);
    assert.deepEqual(Object.keys(payload), ['prerelease', 'body']);
    assert.equal(payload.prerelease, false);
    assert.ok(payload.body.startsWith(release.body));
    assert.ok(payload.body.includes(evidence));
    assert.ok(payload.body.includes(receipt.reportSha256));
    writeCount++;
    release = { ...release, ...payload };
    return release;
  };
  const options = { request, updateRelease };
  assert.equal(await publishApprovedRelease(receipt, options), evidence);
  assert.equal(await publishApprovedRelease(receipt, options), evidence);
  assert.equal(writeCount, 1);
  await assert.rejects(publishApprovedRelease({ ...receipt, releaseId: releaseId + 1 }, options), /expected immutable/);
  await assert.rejects(publishApprovedRelease({ ...receipt, workflowRunId: '1441' }, options), /already Stable without/);
  assert.equal(writeCount, 1);
});

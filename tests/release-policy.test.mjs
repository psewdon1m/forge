import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog, draftReport, gate, validatePublicPart12Report, verifyWorkflowRun } from '../scripts/release-policy.mjs';
import { matchQualifiedRef } from '../scripts/qualified-release-ref.mjs';

const commit = 'a'.repeat(40);
const tag = 'forge-v0.0.1';
const refs = new Map([['refs/heads/main', commit], ['refs/tags/' + tag, 'b'.repeat(40)], ['refs/tags/' + tag + '^{}', commit]]);
const subjects = { revision: commit, tag, packageSha256: '4'.repeat(64) };
const review = () => ({
  schema_version: 1, service: 'forge', revision: commit, release_tag: tag, candidate_sha256: subjects.packageSha256, ...catalog,
  checks: [
    { id: 'REL-01', status: 'PASS', evidence: ['test-fixture result'], reason: null },
    { id: 'CTR-01', status: 'N/A', evidence: ['test-fixture profile'], reason: 'Windows portable client has no container runtime' },
  ],
});

test('qualified tag resolves to the exact checked-out main commit', () => {
  const input = { ref: 'refs/tags/' + tag, version: '0.0.1', commit, refs };
  assert.deepEqual(matchQualifiedRef(input), { version: input.version, tag, commit });
  assert.throws(() => matchQualifiedRef({ ...input, ref: 'refs/tags/v0.0.1' }), /qualified release tag/i);
  assert.throws(() => matchQualifiedRef({ ...input, version: '0.0.2' }), /qualified release tag/i);
  assert.throws(() => matchQualifiedRef({ ...input, commit: 'c'.repeat(40) }), /must be identical/i);
});

test('Part 12 gate requires all IDs and exact candidate and policy binding', () => {
  const ids = new Set(['REL-01', 'CTR-01']);
  assert.equal(gate(review(), subjects, ids), 2);
  for (const override of [
    { revision: 'c'.repeat(40) }, { candidate_sha256: '5'.repeat(64) }, { catalog_sha256: '0'.repeat(64) },
  ]) assert.throws(() => gate({ ...review(), ...override }, subjects, ids));
  const report = review();
  const [pass, na] = report.checks;
  for (const checks of [[pass], [pass, pass], [pass, { ...na, reason: '' }], [pass, { ...na, status: 'UNKNOWN' }]]) {
    assert.throws(() => gate({ ...report, checks }, subjects, ids));
  }
});

test('a Part 12 draft preserves exact subjects and leaves every check unresolved', () => {
  const ids = new Set(['REL-01', 'CTR-01']);
  const report = draftReport(subjects, ids);
  assert.equal(report.revision, commit);
  assert.equal(report.candidate_sha256, subjects.packageSha256);
  assert.equal(report.catalog_sha256, catalog.catalog_sha256);
  assert.deepEqual(report.checks.map(check => check.id), [...ids]);
  assert.ok(report.checks.every(check => check.status === 'UNKNOWN'));
  assert.throws(() => gate(report, subjects, ids), /Unresolved IDs: REL-01, CTR-01/);
});

test('candidate and review run IDs bind to different workflow events on the exact Forge revision', () => {
  const record = {
    id: 57291, head_repository: { full_name: 'psewdon1m/forge' }, head_sha: commit,
    path: '.github/workflows/release.yml', event: 'push', status: 'completed', conclusion: 'success',
  };
  const expected = { revision: commit, id: String(record.id) };
  verifyWorkflowRun(record, { ...expected, role: 'candidate' });
  assert.throws(() => verifyWorkflowRun(record, { ...expected, role: 'review' }), /expected workflow/);
  assert.throws(() => verifyWorkflowRun(record, { ...expected, role: 'signed' }), /expected workflow/);
  verifyWorkflowRun({ ...record, event: 'workflow_dispatch' }, { ...expected, role: 'signed' });
  const reviewed = { ...record, path: '.github/workflows/release-review.yml', event: 'workflow_dispatch' };
  verifyWorkflowRun(reviewed, { ...expected, role: 'review' });
  for (const override of [
    { id: 57292 }, { path: '.github/workflows/verify.yml' }, { event: 'pull_request' },
    { head_sha: 'b'.repeat(40) }, { head_repository: { full_name: 'fork/forge' } },
    { status: 'in_progress' }, { conclusion: 'failure' },
  ]) assert.throws(() => verifyWorkflowRun({ ...reviewed, ...override }, { ...expected, role: 'review' }), /expected workflow/);
});

test('public reports reject local receipts, fields and paths before they enter the delivery', () => {
  const id = 'REL-12';
  const base = draftReport(subjects, new Set([id]));
  const row = { id, status: 'N/A', reason: 'The release has no public predecessor.', evidence: ['https://github.com/psewdon1m/forge/releases'] };
  const review = { ...base, checks: [row] };
  assert.doesNotThrow(() => validatePublicPart12Report(review));
  for (const invalid of [
    'evidence.json', '.history/forge/verification.json', 'C:/Users/Owner/test.json', 'file:///tmp/verification.json',
    'https://localhost/verification', 'https://anything.local/test', 'https://127.0.0.1/test',
    'https://[::1]/test', 'https://someone@github.com/test', 'https://github.com/test?private=data',
    'https://github.com/test (extra file path)',
  ]) {
    assert.throws(() => validatePublicPart12Report({ ...review, checks: [{ ...row, evidence: [invalid] }] }), /public HTTPS evidence/);
  }
  assert.throws(() => validatePublicPart12Report({ ...review, rawLog: 'private' }), /Unexpected fields/);
  assert.throws(() => validatePublicPart12Report({ ...review, checks: [{ ...row, localLog: 'private' }] }), /Unexpected fields/);
  assert.throws(() => validatePublicPart12Report({ ...review, checks: [{ ...row, reason: 'Log under C:\\Users\\Owner\\QA' }] }), /Local paths/);
});
test('only explicit evidence deferred to its legitimate phase can pass an earlier gate', () => {
  const checks = new Map([
    ['REL-01', undefined],
    ['REL-06', 'signed-artifact'],
    ['REL-09', 'release-ready'],
    ['REL-12', 'pre-publication'],
    ['TRUST-03', 'release-ready'],
  ]);
  const phasedIds = new Set(checks.keys());
  const completed = id => ({ id, status: 'PASS', evidence: [`qualification-${id}.json`], reason: null });
  const pending = (id, phase) => ({
    id, status: 'UNKNOWN', deferred_until: phase,
    evidence: ['immutable-release-qualification-procedure.md'], reason: 'The actual expected artifacts must be available for this check.',
  });
  const report = draftReport(subjects, phasedIds);
  report.checks = [...checks].map(([id, phase]) => phase ? pending(id, phase) : completed(id));
  assert.equal(gate(report, subjects, phasedIds, { phase: 'pre-signing' }), phasedIds.size);
  assert.throws(() => gate(report, subjects, phasedIds, { phase: 'signed-artifact' }), /Unresolved IDs: REL-06/);
  const signed = { ...report, checks: report.checks.map(row => row.id === 'REL-06' ? completed(row.id) : row) };
  assert.equal(gate(signed, subjects, phasedIds, { phase: 'signed-artifact' }), phasedIds.size);
  assert.throws(() => gate(signed, subjects, phasedIds, { phase: 'pre-publication' }), /Unresolved IDs: REL-12/);
  assert.throws(() => gate(signed, subjects, phasedIds), /Unresolved IDs: REL-09, REL-12, TRUST-03/);
  const prePublication = { ...signed, checks: signed.checks.map(row => row.id === 'REL-12' ? completed(row.id) : row) };
  assert.equal(gate(prePublication, subjects, phasedIds, { phase: 'pre-publication' }), phasedIds.size);
  assert.equal(gate({ ...signed, checks: [...phasedIds].map(completed) }, subjects, phasedIds), phasedIds.size);
  for (const row of [
    pending('REL-01', 'release-ready'),
    pending('REL-06', 'release-ready'),
    { ...pending('REL-09', 'release-ready'), status: 'FAIL' },
    { ...pending('REL-09', 'release-ready'), reason: '' },
    { ...pending('TRUST-03', 'release-ready'), evidence: [] },
    completed('TRUST-03'),
    pending('REL-12', 'release-ready'),
    completed('REL-12'),
  ]) {
    const modified = { ...report, checks: report.checks.map(check => check.id === row.id ? row : check) };
    assert.throws(() => gate(modified, subjects, phasedIds, { phase: 'pre-signing' }));
  }
  assert.throws(() => gate(report, { ...subjects, revision: 'f'.repeat(40) }, phasedIds, { phase: 'pre-signing' }));
  assert.throws(() => gate({ ...report, checks: [...phasedIds].map(id => id === 'REL-09' ? {
    id, status: 'N/A', evidence: ['not applicable fixture'], reason: 'Wrong profile for Forge',
  } : completed(id)) }, subjects, phasedIds), /Unresolved IDs: REL-09/);
  const first = { ...signed, checks: signed.checks.map(row => row.id === 'REL-12' ? {
    id: row.id, status: 'N/A', evidence: ['release history receipt'], reason: 'No published Forge predecessor.',
  } : row) };
  assert.equal(gate(first, subjects, phasedIds, { phase: 'pre-publication' }), phasedIds.size);
  const later = { ...subjects, tag: 'forge-v0.0.2' };
  assert.throws(() => gate({ ...first, release_tag: later.tag }, later, phasedIds, { phase: 'pre-publication' }), /Unresolved IDs: REL-12/);
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { commitFormat, stableVersion } from './release-format.mjs';

export const catalog = Object.freeze({
  catalog_repository: 'https://github.com/psewdon1m-exocortex/general',
  catalog_revision: '4449e65d732ca44b91cec5a6f3ca16c2c618578f',
  catalog_path: 'PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md',
  catalog_sha256: '7f356b724df80444c5cd00c15bd808046f4f5667afa2cabf87cf1acd196c86a9',
});
const rawRoot = 'https://raw.githubusercontent.com/psewdon1m-exocortex/general/' + catalog.catalog_revision + '/';
const catalogLimit = 96 * 1024;
const checkStatuses = new Set(['PASS', 'N/A']);
const phaseOrder = ['pre-signing', 'signed-artifact', 'release-ready'];
const deferredChecks = new Map([
  ['REL-06', 'signed-artifact'],
  ['REL-09', 'release-ready'],
  ['TRUST-03', 'release-ready'],
]);
const hex64 = /^[a-f0-9]{64}$/;
const runRequirements = new Map([
  ['candidate', { path: '.github/workflows/release.yml', event: 'push' }],
  ['review', { path: '.github/workflows/release-review.yml', event: 'workflow_dispatch' }],
  ['signed', { path: '.github/workflows/release.yml', event: 'workflow_dispatch' }],
]);

function content(text, name, max = 2000) {
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > max || /[\p{Cc}]/u.test(text)) {
    throw new Error('Invalid or missing ' + name);
  }
}

export function structuralCheck(bytes) {
  if (bytes.length > catalogLimit || createHash('sha256').update(bytes).digest('hex') !== catalog.catalog_sha256) {
    throw new Error('Part 12 bytes do not match the pinned policy digest');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const ids = new Set();
  let category;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) category = /^## ([A-Z]+) — /.exec(line)?.[1];
    if (!category || !/^\|\s*\*\*/.test(line)) continue;
    const row = /^\|\s+\*\*([A-Z]+-\d{2})\*\*\s+\|\s+(.+?)\s+\|\s+(.+?)\s+\|$/.exec(line);
    if (!row || !row[1].startsWith(category + '-') || ids.has(row[1]) || !row[2].trim() || !row[3].trim()) {
      throw new Error('Invalid, duplicate or incomplete active problem ID in Part 12');
    }
    ids.add(row[1]);
  }
  if (!ids.size) throw new Error('Part 12 has no recognized active problem IDs');
  const links = new Set();
  for (const match of text.matchAll(/\]\(\.\/([^\s)]+)\)/g)) {
    const relative = match[1];
    if (!/^PART_\d{2}_[A-Z0-9_]+\.md(?:#[a-z0-9-]+)?$/.test(relative)) throw new Error('Unsupported local link in immutable Part 12');
    links.add(relative.split('#')[0]);
  }
  return { ids, links };
}

async function fetchBoundedCatalog() {
  const response = await fetch(rawRoot + catalog.catalog_path, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error('Pinned Part 12 download failed, HTTP ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > catalogLimit) throw new Error('Pinned Part 12 download exceeds its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function loadCatalog() {
  const result = structuralCheck(await fetchBoundedCatalog());
  await Promise.all([...result.links].map(async name => {
    const link = await fetch(rawRoot + name, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!link.ok) throw new Error('Missing document at pinned Part 12 link ' + name);
  }));
  return result;
}

function checkSubjects(subjects) {
  const { tag, revision, packageSha256 } = subjects;
  if (typeof tag !== 'string' || !tag.startsWith('forge-v') || !stableVersion.test(tag.slice(7)) ||
      !commitFormat.test(revision ?? '') || !hex64.test(packageSha256 ?? '')) throw new Error('Invalid exact-candidate subjects');
}

export function draftReport(subjects, ids) {
  checkSubjects(subjects);
  return {
    schema_version: 1, service: 'forge', revision: subjects.revision, release_tag: subjects.tag,
    candidate_sha256: subjects.packageSha256, ...catalog,
    checks: [...ids].map(id => ({ id, status: 'UNKNOWN', evidence: [], reason: null })),
  };
}

export function verifyWorkflowRun(run, { role, revision, id }) {
  const expected = runRequirements.get(role);
  if (!expected || !commitFormat.test(revision ?? '') || !/^[1-9]\d{0,19}$/.test(id ?? '')) {
    throw new Error('Invalid qualified workflow run identity');
  }
  if (!Number.isSafeInteger(run?.id) || String(run.id) !== id ||
      run.head_repository?.full_name !== 'psewdon1m/forge' || run.head_sha !== revision ||
      run.path !== expected.path || run.event !== expected.event ||
      run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('The ' + role + ' run is not a successful run of the expected workflow on the exact Forge commit');
  }
}

export function gate(report, subjects, ids, { phase = 'release-ready' } = {}) {
  const currentPhase = phaseOrder.indexOf(phase);
  if (currentPhase < 0) throw new Error('Invalid Part 12 gate phase');
  checkSubjects(subjects);
  const { tag, revision, packageSha256 } = subjects;
  if (!report || report.schema_version !== 1 || report.service !== 'forge' || report.revision !== revision ||
      report.release_tag !== tag || report.candidate_sha256 !== packageSha256) throw new Error('Part 12 report is missing or stale for this candidate');
  for (const [key, value] of Object.entries(catalog)) {
    if (report[key] !== value) throw new Error('Part 12 report has a different ' + key);
  }
  if (!Array.isArray(report.checks)) throw new Error('Part 12 report is missing its check rows');
  const seen = new Set();
  const unresolved = [];
  for (const check of report.checks) {
    if (!ids.has(check?.id) || seen.has(check.id)) throw new Error('Unknown or duplicate Part 12 ID ' + check?.id);
    seen.add(check.id);
    const requiredPhase = deferredChecks.get(check.id);
    const deferred = check.status === 'UNKNOWN' && requiredPhase !== undefined &&
      check.deferred_until === requiredPhase && currentPhase < phaseOrder.indexOf(requiredPhase);
    if (requiredPhase && (currentPhase < phaseOrder.indexOf(requiredPhase) ? !deferred : check.status !== 'PASS')) {
      unresolved.push(check.id);
      continue;
    }
    if (!deferred && !checkStatuses.has(check.status)) {
      unresolved.push(check.id);
      continue;
    }
    if (!deferred && check.deferred_until !== undefined) throw new Error('Invalid completed Part 12 row ' + check.id);
    if (!Array.isArray(check.evidence) || check.evidence.length < 1 || check.evidence.length > 12) {
      throw new Error('Part 12 evidence is required for ' + check.id);
    }
    for (const reference of check.evidence) content(reference, 'evidence for ' + check.id, 500);
    if (deferred || check.status === 'N/A') content(check.reason, 'phase or applicability reason for ' + check.id);
  }
  const missing = [...ids].filter(id => !seen.has(id));
  if (missing.length || unresolved.length) {
    throw new Error('Part 12 gate stopped the release. Missing IDs: ' + missing.join(', ') + '. Unresolved IDs: ' + unresolved.join(', ') + '.');
  }
  return seen.size;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'catalog' && args.length === 0) {
    const { ids, links } = await loadCatalog();
    console.log(JSON.stringify({ ...catalog, ids: ids.size, checkedLinks: links.size }));
    return;
  }
  if (mode === 'draft' && args.length === 1) {
    const manifest = JSON.parse((await readFile(args[0], 'utf8')).replace(/^\uFEFF/, ''));
    const { ids } = await loadCatalog();
    const report = draftReport({ tag: manifest.tag, revision: manifest.commitSha, packageSha256: manifest.artifact?.sha256 }, ids);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (mode === 'run' && args.length === 3) {
    const [role, revision, id] = args;
    verifyWorkflowRun(JSON.parse(readFileSync(0, 'utf8')), { role, revision, id });
    return;
  }
  if (mode === 'gate' && args.length === 4) {
    const [reportFile, tag, revision, packageSha256] = args;
    const { ids } = await loadCatalog();
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    const passed = gate(report, { tag, revision, packageSha256 }, ids);
    console.log('Part 12 gate verified ' + passed + ' check rows for ' + tag);
    return;
  }
  throw new Error('Use release-policy.mjs catalog, draft MANIFEST, run ROLE COMMIT RUN_ID or gate REPORT TAG COMMIT PACKAGE_SHA256');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

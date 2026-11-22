import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapName, candidateDeliveryFiles, canonical, fileDigest, manifestFor, packageName } from './release-format.mjs';
import { gate, loadCatalog, validatePublicPart12Report } from './release-policy.mjs';

const [delivery, reportFile, approvalDir, version, commitSha, runId] = process.argv.slice(2);
if (process.argv.length !== 8 || !/^\d{1,20}$/.test(runId)) throw new Error('Expected candidate paths, version, commit and run');
const anchor = process.env.FORGE_RELEASE_PUBLIC_KEY_HEX;
if (!/^[0-9a-f]{64}$/.test(anchor ?? '')) throw new Error('Expected the pinned release public key');
const publicKeySha256 = createHash('sha256').update(Buffer.from(anchor, 'hex')).digest('hex');
const read = name => readFile(path.join(delivery, name), 'utf8');
const digest = name => fileDigest(path.join(delivery, name));

const zip = packageName(version);
const setup = bootstrapName(version);
const notes = await read('release-notes.md');
const manifest = await manifestFor({ version, commitSha, packagePath: path.join(delivery, zip), notes });
if (await read('forge-release.unsigned.json') !== canonical(manifest)) throw new Error('Unsigned manifest does not describe the exact bundle');
const smoke = JSON.parse(await read('forge-package-smoke.json'));
const setupSha256 = await digest(setup);
if (Object.hasOwn(smoke, 'delivery') || smoke.outcome !== 'PASS' || smoke.candidateCommitIsFixture !== false || smoke.candidateCommit !== commitSha ||
    smoke.version !== version || smoke.packageSha256 !== manifest.artifact.sha256 || smoke.setupSha256 !== setupSha256 ||
    smoke.offNetwork !== true || smoke.launchedExactSlotAndCreatedLocalProject !== true) {
  throw new Error('Candidate smoke evidence is missing or does not match this package');
}
const files = candidateDeliveryFiles(version);
const checksums = new Map(await Promise.all(files.map(async name => [name, await digest(name)])));
const expected = files.map(name => checksums.get(name) + '  ' + name + '\n').join('');
if (await read('SHA256SUMS') !== expected) throw new Error('Candidate checksums do not match the release files');
const provenance = JSON.parse(await read('forge-build-provenance.json'));
if (provenance.predicate?.source?.commitSha !== commitSha || provenance.predicate?.builder?.run !== runId ||
    provenance.predicate?.releasePublicKeySha256 !== publicKeySha256 ||
    provenance.subject.length !== files.length - 1 || !files.slice(0, -1).every(name =>
      provenance.subject.some(subject => subject.name === name && subject.digest?.sha256 === checksums.get(name)))) {
  throw new Error('Candidate provenance, run or pinned key does not match');
}
const { ids } = await loadCatalog();
const report = JSON.parse(await readFile(reportFile, 'utf8'));
gate(report, { tag: manifest.tag, revision: commitSha, packageSha256: manifest.artifact.sha256 }, ids, { phase: 'pre-signing' });
validatePublicPart12Report(report);
await mkdir(approvalDir);
await copyFile(reportFile, path.join(approvalDir, 'known-problems-report.json'));
await writeFile(path.join(approvalDir, 'approval.json'), canonical({
  tag: manifest.tag, version, commitSha, runId, publicKeySha256,
  checksums: Object.fromEntries(checksums),
  manifestSha256: await digest('forge-release.unsigned.json'),
  smokeSha256: await digest('forge-package-smoke.json'),
  reportSha256: await fileDigest(reportFile),
}), { flag: 'wx' });

import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapName, candidateDeliveryFiles, canonical, commitFormat, fileDigest, hasWindowsInstaller, installerName, manifestDomain, manifestFor, packageName, stableVersion } from './release-format.mjs';
import { gate, loadCatalog, validatePublicPart12Report, verifyFirstReleaseApplicability } from './release-policy.mjs';

const hexDigest = /^[0-9a-f]{64}$/;

export async function verifySignedRelease(directory, approval, anchor, installerReceipt) {
  if (!hexDigest.test(anchor ?? '') || !stableVersion.test(approval?.version ?? '') ||
      !commitFormat.test(approval?.commitSha ?? '') || approval.tag !== 'forge-v' + approval.version) {
    throw new Error('Invalid signed release identity or public anchor');
  }

  const rawKey = Buffer.from(anchor, 'hex');
  const fingerprint = createHash('sha256').update(rawKey).digest('hex');
  if (approval.publicKeySha256 !== fingerprint) throw new Error('Public anchor differs from the release approval');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') } });
  const local = file => path.join(directory, file);
  const zip = packageName(approval.version);
  const setup = bootstrapName(approval.version);
  const reviewed = candidateDeliveryFiles(approval.version);
  const expected = new Map([
    ...reviewed.map(file => [file, approval.checksums?.[file]]),
    ['forge-package-smoke.json', approval.smokeSha256],
    ['known-problems-report.json', approval.reportSha256],
    ['forge-release.json', approval.manifestSha256],
  ]);
  for (const [file, approvedHash] of expected) {
    if (!hexDigest.test(approvedHash ?? '') || await fileDigest(local(file)) !== approvedHash) {
      throw new Error('Signed release file differs from the approval: ' + file);
    }
  }

  const expectedManifest = await manifestFor({
    version: approval.version, commitSha: approval.commitSha, packagePath: local(zip),
    notes: await readFile(local('release-notes.md'), 'utf8'),
  });
  const manifest = await readFile(local('forge-release.json'));
  if (manifest.toString('utf8') !== canonical(expectedManifest)) throw new Error('Signed manifest differs from the exact package identity');
  const signature = await readFile(local('forge-release.sig'));
  if (signature.length !== 64 || !verify(null, Buffer.concat([Buffer.from(manifestDomain, 'ascii'), manifest]), key, signature)) {
    throw new Error('The detached release signature is invalid');
  }
  expected.set('forge-release.sig', createHash('sha256').update(signature).digest('hex'));
  const installer = installerName(approval.version);
  if (installerReceipt) {
    const inputs = Object.fromEntries([setup, zip, 'forge-release.json', 'forge-release.sig'].map(name => [name, expected.get(name)]));
    if (installerReceipt.name !== installer || installerReceipt.revision !== approval.commitSha ||
        canonical(installerReceipt.inputs) !== canonical(inputs) || !hexDigest.test(installerReceipt.sha256 ?? '') ||
        await fileDigest(local(installer)) !== installerReceipt.sha256) {
      throw new Error('Windows installer does not match the signed delivery and assembly record');
    }
    expected.set(installer, installerReceipt.sha256);
  }
  const sums = [...expected].map(([name, digest]) => `${digest}  ${name}\n`).join('');
  if (await readFile(local('SHA256SUMS'), 'utf8') !== sums) throw new Error('Signed release checksum inventory does not match');
  expected.set('SHA256SUMS', createHash('sha256').update(sums).digest('hex'));
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some(entry => !entry.isFile() || !expected.has(entry.name))) {
    throw new Error('Unexpected files in the signed release delivery');
  }
  const fileSizes = await Promise.all([...expected.keys()].map(async name => [name, (await stat(local(name))).size]));

  return {
    outcome: 'PASS', tag: approval.tag, revision: approval.commitSha,
    packageSha256: expected.get(zip), setupSha256: expected.get(setup),
    ...(installerReceipt ? { installerSha256: expected.get(installer) } : {}),
    publicKeySha256: fingerprint, checkedFiles: Object.fromEntries(expected), fileSizes: Object.fromEntries(fileSizes),
  };
}

export function completeSignedReport(report, verification, ids, runUrl, noStablePredecessor = false) {
  gate(report, verification, ids, { phase: 'pre-signing', noStablePredecessor });
  const completed = {
    ...report,
    checks: report.checks.map(row => row.id === 'REL-06' ? {
      id: row.id, status: 'PASS', evidence: [runUrl], reason: null,
    } : row),
  };
  gate(completed, verification, ids, { phase: 'signed-artifact', noStablePredecessor });
  return completed;
}

async function main() {
  const [directory, approvalPath, outputDirectory, installerPath] = process.argv.slice(2);
  if (!outputDirectory || process.argv.length > 6) {
    throw new Error('Use verify-signed-release.mjs SIGNED_DIRECTORY APPROVAL_JSON OUTPUT_DIRECTORY [INSTALLER_RECEIPT]');
  }
  const runId = process.env.GITHUB_RUN_ID;
  if (!/^[1-9]\d{0,19}$/.test(runId ?? '') || process.env.GITHUB_REPOSITORY !== 'psewdon1m/forge') throw new Error('Expected a Forge signing workflow run');
  const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  if (process.env.GITHUB_REF !== 'refs/tags/' + approval.tag || process.env.GITHUB_SHA !== approval.commitSha) {
    throw new Error('The signing workflow differs from the approved ref');
  }
  if (hasWindowsInstaller(approval.version) !== Boolean(installerPath)) throw new Error('Missing or unexpected Windows installer receipt');
  const installer = installerPath && JSON.parse(await readFile(installerPath, 'utf8'));
  const verification = await verifySignedRelease(directory, approval, process.env.FORGE_RELEASE_PUBLIC_KEY_HEX, installer);
  const report = JSON.parse(await readFile(path.join(directory, 'known-problems-report.json'), 'utf8'));
  const { ids } = await loadCatalog();
  const noStablePredecessor = await verifyFirstReleaseApplicability(report);
  const signedReport = completeSignedReport(report, verification, ids, 'https://github.com/psewdon1m/forge/actions/runs/' + runId, noStablePredecessor);
  validatePublicPart12Report(signedReport);
  const completed = canonical(signedReport);
  await mkdir(outputDirectory);
  await writeFile(path.join(outputDirectory, 'signed-phase-report.json'), completed, { flag: 'wx' });
  await writeFile(path.join(outputDirectory, 'signed-verification.json'), canonical({
    ...verification, runId, signedReportSha256: createHash('sha256').update(completed).digest('hex'),
  }), { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

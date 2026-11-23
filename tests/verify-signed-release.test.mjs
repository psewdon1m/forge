import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapName, ed25519PublicHex, fileDigest, installerName, manifestDomain, manifestFor, packageName, signRecord } from '../scripts/release-format.mjs';
import { verifySignedRelease } from '../scripts/verify-signed-release.mjs';

test('signed release verifies against the approved bytes and pinned public key', async () => {
  const delivery = await mkdtemp(path.join(tmpdir(), 'forge-signed-review-'));
  const file = name => path.join(delivery, name);
  const version = '0.0.5';
  const commitSha = 'a'.repeat(40);
  const zip = packageName(version);
  const bootstrap = bootstrapName(version);
  const payloads = new Map([
    [zip, 'Package fixture'], [bootstrap, 'Bootstrap fixture'], ['forge-sbom.cdx.json', '{}'],
    ['release-notes.md', 'Notes for the fixture.'], ['forge-build-provenance.json', '{}'],
    ['forge-package-smoke.json', '{}'], ['known-problems-report.json', '{}'],
  ]);
  for (const [name, bytes] of payloads) await writeFile(file(name), bytes);
  const { privateKey } = generateKeyPairSync('ed25519');
  const anchor = ed25519PublicHex(privateKey);
  const manifest = await manifestFor({ version, commitSha, packagePath: file(zip), notes: payloads.get('release-notes.md') });
  const { bytes, signature } = signRecord(manifestDomain, manifest, privateKey);
  await writeFile(file('forge-release.json'), bytes);
  await writeFile(file('forge-release.sig'), signature);
  const hashes = Object.fromEntries(await Promise.all([...payloads.keys(), 'forge-release.json', 'forge-release.sig']
    .map(async name => [name, await fileDigest(file(name))])));
  const sums = Object.entries(hashes).map(([name, hash]) => `${hash}  ${name}\n`).join('');
  await writeFile(file('SHA256SUMS'), sums);
  const approval = {
    version, commitSha, tag: manifest.tag, checksums: hashes,
    publicKeySha256: createHash('sha256').update(Buffer.from(anchor, 'hex')).digest('hex'),
    manifestSha256: hashes['forge-release.json'], smokeSha256: hashes['forge-package-smoke.json'],
    reportSha256: hashes['known-problems-report.json'],
  };
  const checked = await verifySignedRelease(delivery, approval, anchor);
  assert.equal(checked.outcome, 'PASS');
  assert.equal(checked.packageSha256, hashes[zip]);
  assert.equal(checked.setupSha256, hashes[bootstrap]);
  assert.deepEqual(checked.checkedFiles, { ...hashes, SHA256SUMS: await fileDigest(file('SHA256SUMS')) });
  assert.equal(checked.fileSizes['forge-release.sig'], 64);
  assert.equal(checked.fileSizes[zip], payloads.get(zip).length);
  await assert.rejects(verifySignedRelease(delivery, approval, 'b'.repeat(64)), /anchor differs/);
  await writeFile(file('forge-release.sig'), Buffer.alloc(64));
  await assert.rejects(verifySignedRelease(delivery, approval, anchor), /signature is invalid/);
  await writeFile(file('forge-release.sig'), signature);
  await writeFile(file(bootstrap), 'Different bootstrap');
  await assert.rejects(verifySignedRelease(delivery, approval, anchor), /differs from the approval: Forge-Setup/);
  await writeFile(file(bootstrap), payloads.get(bootstrap));
  await writeFile(file('SHA256SUMS'), sums.replace('forge-release.sig', 'forge-release.changed.sig'));
  await assert.rejects(verifySignedRelease(delivery, approval, anchor), /checksum inventory/);

  const name = installerName(version);
  await writeFile(file(name), 'Installer fixture');
  const hashesForInstaller = [zip, bootstrap, 'forge-release.json', 'forge-release.sig'];
  const receipt = {
    name, revision: commitSha, sha256: await fileDigest(file(name)),
    inputs: Object.fromEntries(hashesForInstaller.map(input => [input, hashes[input]])),
  };
  await writeFile(file('SHA256SUMS'), sums + `${receipt.sha256}  ${name}\n`);
  const assembled = await verifySignedRelease(delivery, approval, anchor, receipt);
  assert.equal(assembled.installerSha256, receipt.sha256);
  assert.equal(assembled.checkedFiles[name], receipt.sha256);
  await assert.rejects(verifySignedRelease(delivery, approval, anchor, {
    ...receipt, inputs: { ...receipt.inputs, [zip]: 'b'.repeat(64) },
  }), /assembly record/);
  await writeFile(file(name), 'Different installer');
  await assert.rejects(verifySignedRelease(delivery, approval, anchor, receipt), /assembly record/);
});

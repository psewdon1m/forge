import { createHash, createPublicKey, sign } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';

export const releaseBase = 'https://github.com/psewdon1m/forge/releases/download';
export const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const commitFormat = /^[0-9a-f]{40}$/;
export const manifestDomain = 'forge.release.v1\0';
export const rotationDomain = 'forge.release-key-transition.v1\0';
export const helperVersion = readFileSync(new URL('../crates/forge-update-helper/helper-version.txt', import.meta.url), 'utf8').trim();

export const packageName = version => 'forge-' + version + '-windows-x64.zip';
export const bootstrapName = version => 'Forge-Setup-' + version + '.exe';
export const installerName = version => 'Forge-Installer-' + version + '.exe';

export function hasWindowsInstaller(version) {
  // Releases before 0.0.5 were published with only the command-line bootstrap.
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 0 || minor > 0 || patch >= 5;
}

export function candidateDeliveryFiles(version) {
  return [packageName(version), bootstrapName(version), 'forge-sbom.cdx.json', 'release-notes.md', 'forge-build-provenance.json'];
}

export function signedDeliveryFiles(version) {
  return [...candidateDeliveryFiles(version), 'forge-package-smoke.json', 'known-problems-report.json',
    'forge-release.json', 'forge-release.sig', ...(hasWindowsInstaller(version) ? [installerName(version)] : []), 'SHA256SUMS'];
}

export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isSafeInteger(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!value || typeof value !== 'object') throw new Error('Unsupported release JSON value');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function manifestFor({ version, commitSha, packagePath, notes }) {
  if (!stableVersion.test(version) || !commitFormat.test(commitSha)) throw new Error('Invalid release identity');
  if (!stableVersion.test(helperVersion)) throw new Error('Invalid updater compatibility version');
  const tag = 'forge-v' + version;
  return {
    product: 'forge', schemaVersion: 1, platform: 'windows-x64', channel: 'stable',
    version, tag, commitSha,
    dataPolicy: 'no-migration-v1',
    artifact: {
      url: releaseBase + '/' + tag + '/' + packageName(version),
      bytes: (await stat(packagePath)).size, sha256: await fileDigest(packagePath),
    },
    compatibility: {
      helperMin: helperVersion, helperMax: helperVersion, projectSchemaMin: 1, projectSchemaMax: 1, minimumWindowsBuild: 22000,
    },
    releaseNotes: notes.replaceAll('\r\n', '\n').trim(),
  };
}

export function signRecord(domain, data, privateKey) {
  const bytes = Buffer.from(canonical(data), 'utf8');
  return { bytes, signature: sign(null, Buffer.concat([Buffer.from(domain, 'ascii'), bytes]), privateKey) };
}

export function ed25519PublicHex(privateKey) {
  const key = createPublicKey(privateKey).export({ format: 'jwk' });
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519') throw new Error('Expected an Ed25519 release signing key');
  return Buffer.from(key.x, 'base64url').toString('hex');
}

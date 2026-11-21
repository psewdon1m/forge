import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { manifestDomain, packageName, signRecord } from '../scripts/release-format.mjs';

const indexPath = '/repos/psewdon1m/forge/releases';
const manifestFile = 'forge-release.json';
const signatureFile = 'forge-release.sig';

async function tlsFixture(run) {
  const openssl = process.env.FORGE_TEST_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe';
  const ca = path.join(run, 'update-fixture-ca.pem');
  const caKey = path.join(run, 'update-fixture-ca.key');
  const key = path.join(run, 'update-fixture-server.key');
  const request = path.join(run, 'update-fixture-server.csr');
  const certificate = path.join(run, 'update-fixture-server.pem');
  const extensions = path.join(run, 'update-fixture-extensions.cnf');
  const command = args => execFileSync(openssl, args, { windowsHide: true, stdio: 'ignore' });
  await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
  command(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Forge Qualification CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca]);
  command(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', request]);
  command(['x509', '-req', '-in', request, '-CA', ca, '-CAkey', caKey, '-set_serial', '1', '-days', '1', '-extfile', extensions, '-out', certificate]);
  const [serverKey, cert] = await Promise.all([readFile(key), readFile(certificate)]);
  await Promise.all([caKey, key, request, extensions].map(file => unlink(file)));
  return { ca, options: { key: serverKey, cert } };
}

function listing(manifest, { draft = false } = {}) {
  return {
    tag_name: manifest.tag, draft, prerelease: false, immutable: true, published_at: '2026-01-01T00:00:00Z',
    assets: [manifestFile, signatureFile, packageName(manifest.version)].map(name => ({
      name, state: 'uploaded', browser_download_url: 'https://untrusted.example/the-listing-cannot-select-urls',
    })),
  };
}

export async function startUpdateChannel({ run, installed, newer, packagePath, signingKey }) {
  const { ca, options } = await tlsFixture(run);
  let mode = 'current';
  let delayedIndex;
  let respondIndex;
  let delayedPackage;
  let respondPackage;
  let packageTransientResponses;
  let closed = false;
  const requests = [];
  const indexErrors = new Map([['indexUnauthorized', 401], ['indexMissing', 404], ['indexUnavailable', 503]]);
  function activeManifest() {
    if (mode === 'current') return installed;
    if (mode === 'incompatible') {
      return { ...newer, compatibility: { ...newer.compatibility, projectSchemaMin: 2, projectSchemaMax: 2 } };
    }
    if (mode === 'conflict') return { ...installed, artifact: { ...installed.artifact, sha256: 'c'.repeat(64) } };
    if (mode === 'changedCandidate') return { ...newer, artifact: { ...newer.artifact, sha256: 'c'.repeat(64) } };
    if (mode === 'wrongChannel') return { ...newer, channel: 'testing' };
    return newer;
  }
  const server = createServer(options, (request, response) => {
    const address = new URL(request.url, 'https://127.0.0.1');
    requests.push({ path: address.pathname, query: address.search, cache: request.headers['cache-control'],
      pragma: request.headers.pragma, receivedAt: performance.now() });
    response.setHeader('Cache-Control', 'no-store');
    const manifest = activeManifest();
    if (address.pathname === indexPath) {
      response.setHeader('Content-Type', 'application/json');
      if (indexErrors.has(mode)) {
        response.writeHead(indexErrors.get(mode));
        return response.end(JSON.stringify({ detail: 'synthetic private response body' }));
      }
      if (mode === 'invalidIndex') return response.end(JSON.stringify({ detail: 'partial release listing' }));
      const callback = () => response.end(JSON.stringify(mode === 'empty' ? [] : [listing(newer, { draft: true }), listing(manifest)]));
      if (delayedIndex) {
        delayedIndex = false;
        respondIndex = callback;
      } else callback();
      return;
    }
    const releasePath = '/psewdon1m/forge/releases/download/' + manifest.tag + '/';
    if (address.pathname === releasePath + manifestFile) {
      response.writeHead(302, { Location: mode === 'redirect' ? 'https://untrusted.example/rejected' :
        'https://release-assets.githubusercontent.com/forge-qualification/manifest?token=synthetic' });
      response.end();
      return;
    }
    const signed = signRecord(manifestDomain, manifest, signingKey);
    if (address.pathname === '/forge-qualification/manifest') {
      if (mode === 'metadataUnavailable') {
        response.writeHead(503);
        return response.end('synthetic private response body');
      }
      return response.end(signed.bytes);
    }
    if (address.pathname === releasePath + signatureFile) {
      if (mode === 'badSignature') signed.signature[0] ^= 1;
      return response.end(signed.signature);
    }
    const originPackage = manifest.version === newer.version && address.pathname === releasePath + packageName(newer.version);
    if (originPackage && packageTransientResponses) {
      response.writeHead(302, { Location: 'https://release-assets.githubusercontent.com/forge-qualification/archive?token=synthetic' });
      return response.end();
    }
    const cdnPackage = packageTransientResponses && address.pathname === '/forge-qualification/archive';
    if (cdnPackage && packageTransientResponses.length) {
      const { status, retryAfter } = packageTransientResponses.shift();
      response.writeHead(status, { 'Retry-After': retryAfter });
      return response.end('Synthetic temporary response');
    }
    if (originPackage || cdnPackage) {
      const corrupt = mode === 'badArchive';
      const callback = () => {
        if (response.destroyed) return;
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': newer.artifact.bytes });
        void pipeline(createReadStream(packagePath), async function* (source) {
          let first = true;
          for await (const chunk of source) {
            if (first && corrupt) chunk[0] ^= 1;
            first = false;
            yield chunk;
          }
        }, response).catch(() => response.destroy());
      };
      if (delayedPackage) {
        delayedPackage = false;
        respondPackage = callback;
      } else callback();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    nextVersion: newer.version,
    packageSha256: newer.artifact.sha256,
    releaseNotes: newer.releaseNotes,
    requests,
    env: { FORGE_TEST_DISCOVERY_ORIGIN: 'https://127.0.0.1:' + server.address().port + '/', FORGE_TEST_DISCOVERY_CA: ca },
    select(value) { mode = value; },
    retryPackage(responses) { packageTransientResponses = [...responses]; },
    delay() { delayedIndex = true; },
    release() { assert.equal(typeof respondIndex, 'function'); respondIndex(); respondIndex = undefined; },
    get waiting() { return Boolean(respondIndex); },
    delayPackage() { delayedPackage = true; },
    releasePackage() { assert.equal(typeof respondPackage, 'function'); respondPackage(); respondPackage = undefined; },
    get packageWaiting() { return Boolean(respondPackage); },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

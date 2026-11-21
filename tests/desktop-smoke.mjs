import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron as electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const evidence = path.join(root, '.local', 'qualification');
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(path.join(evidence, 'run-'));
const data = path.join(run, 'browser');
let active;

const keyPath = path.join(run, 'fixture-key.pem');
const certPath = path.join(run, 'fixture-cert.pem');
const openssl = process.env.FORGE_TEST_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe';
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', keyPath, '-out', certPath], { windowsHide: true, stdio: 'ignore' });
const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
await Promise.all([unlink(keyPath), unlink(certPath)]);
const fingerprint = new X509Certificate(cert).fingerprint256;
const server = createServer({ key, cert }, (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/sign-in') {
    response.writeHead(302, {
      'Set-Cookie': 'forge_fixture=signed-in; Max-Age=86400; HttpOnly; Secure; SameSite=Lax; Path=/',
      Location: '/',
    });
    response.end();
    return;
  }
  if (request.url === '/download') {
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture.txt"', 'Content-Type': 'text/plain' });
    response.end('fixture bytes');
    return;
  }
  if (request.url === '/popup') {
    response.end('popup');
    return;
  }
  response.setHeader('Content-Type', 'text/html;charset=utf-8');
  const label = request.headers.cookie?.includes('forge_fixture=signed-in') ? 'Signed in' : 'Guest';
  response.end('<!doctype html><title>Site fixture</title><h1>' + label +
    '</h1><a href="/sign-in">Sign in</a> <a target="_blank" href="/popup">Open popup</a> <a href="/download">Download</a>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'https://127.0.0.1:' + server.address().port;
const observations = { runtime: null, canvas: {}, site: {} };

async function launch(fixture = '') {
  const app = await electron.launch({
    executablePath,
    args: [root],
    env: {
      ...process.env,
      FORGE_QUALIFICATION: '1',
      FORGE_QUALIFICATION_DATA: data,
      FORGE_FIXTURE_ORIGIN: origin,
      FORGE_FIXTURE_CERTIFICATE_FINGERPRINT: fingerprint,
      FORGE_CANVAS_FIXTURE: fixture,
    },
  });
  active = app;
  return app;
}

async function inSite(app, name) {
  const id = await app.evaluate(async (_electron, input) =>
    globalThis.forgeQualification.openSite(input.url, input.name),
    { url: origin + '/', name });
  return {
    current: () => app.evaluate(({ webContents }, siteId) =>
      webContents.fromId(siteId).executeJavaScript('document.querySelector("h1")?.textContent'), id),
    click: selector => app.evaluate(({ webContents }, input) =>
      webContents.fromId(input.id).executeJavaScript('document.querySelector(' + JSON.stringify(input.selector) + ').click()'), { id, selector }),
    globals: () => app.evaluate(({ webContents }, siteId) =>
      webContents.fromId(siteId).executeJavaScript('({require: typeof require, process: typeof process, bridge: typeof window.forge})'), id),
  };
}

try {
  let app = await launch();
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'Empty space' })).toBeVisible();
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  await window.getByRole('button', { name: 'Load sample' }).click();
  await expect(window.getByText('3 objects · 1 links')).toBeVisible();
  await window.getByText('Visual references', { exact: true }).dblclick();
  await expect(window.getByRole('heading', { name: 'Visual references' })).toBeVisible();
  await window.getByRole('button', { name: 'Back to Space' }).click();
  await window.getByRole('button', { name: 'Add note' }).click();
  await expect(window.getByText('4 objects · 1 links')).toBeVisible();
  await window.getByRole('button', { name: 'Zoom in' }).click();
  await expect(window.locator('output')).not.toHaveText('100%');
  await window.getByRole('button', { name: 'Reset view' }).click();
  await expect(window.locator('output')).toHaveText('100%');
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const snapshot = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    return snapshot.toPNG().toString('base64');
  });
  assert.ok(image.length > 1000, 'The desktop capture should contain the rendered workspace');
  await writeFile(path.join(run, 'space-sample.png'), Buffer.from(image, 'base64'));
  observations.runtime = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }));
  observations.canvas = { emptyWorkspace: true, openPlain: true, returnToSpace: true, note: true, zoom: true };

  let site = await inSite(app, 'first');
  assert.equal(await site.current(), 'Guest');
  assert.deepEqual(await site.globals(), { require: 'undefined', process: 'undefined', bridge: 'undefined' });
  await site.click('a[href="/sign-in"]');
  await expect.poll(site.current).toBe('Signed in');
  await site.click('a[href="/popup"]');
  await expect.poll(() => app.evaluate(() => globalThis.forgeQualification.observations().popup)).toBe(origin + '/popup');
  await site.click('a[href="/download"]');
  await expect.poll(() => app.evaluate(() => globalThis.forgeQualification.observations().download)).toBe('fixture.txt');
  site = await inSite(app, 'second');
  assert.equal(await site.current(), 'Guest', 'Another Site must not inherit the first session');
  await site.click('a[href="/sign-in"]');
  await expect.poll(site.current).toBe('Signed in');
  await app.close();

  app = await launch();
  await app.firstWindow();
  site = await inSite(app, 'first');
  assert.equal(await site.current(), 'Signed in', 'Site cookie should survive restart');
  const denied = await app.evaluate(async () => {
    try {
      await globalThis.forgeQualification.openSite('file:///C:/Windows/', 'first');
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(denied, true);
  await app.evaluate(async () => globalThis.forgeQualification.clearSite('first'));
  site = await inSite(app, 'first');
  assert.equal(await site.current(), 'Guest', 'Cleared Site must require explicit sign-in');
  site = await inSite(app, 'second');
  assert.equal(await site.current(), 'Signed in', 'Clearing one Site must preserve the other profile');
  observations.site = {
    isolatedRuntime: true, persistentLogin: true, isolatedProfiles: true,
    popupIntercepted: true, downloadIntercepted: true, disallowedUrlRejected: true, selectedProfileCleared: true,
  };
  await writeFile(path.join(run, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
  console.log('Desktop smoke PASS. Evidence: ' + run);
} finally {
  if (active) await active.close();
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

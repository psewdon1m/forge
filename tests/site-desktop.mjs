import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import executablePath from 'electron';
import { _electron, expect } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const parent = path.join(root, '.local', 'qualification');
await mkdir(parent, { recursive: true });
const run = await mkdtemp(path.join(parent, 'site-ui-'));
const project = path.join(run, 'Project');
const savedDownload = path.join(run, 'lighting.txt');
const archive = path.join(run, 'Lighting.zip');
const useLongProfile = process.argv.includes('--long-profile');
const profileName = useLongProfile
  ? 'Profile'.padEnd(174 - run.length - 1, 'p')
  : 'Profile';
const profileDirectory = path.join(run, profileName);
await Promise.all([mkdir(project), mkdir(profileDirectory)]);
const chromeScreenshot = path.join(run, 'site-chrome.png');
const pageScreenshot = path.join(run, 'site-page.png');
const keyPath = path.join(run, 'fixture-key.pem');
const certPath = path.join(run, 'fixture-cert.pem');
const openssl = process.env.FORGE_TEST_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe';
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  '-keyout', keyPath, '-out', certPath], { windowsHide: true, stdio: 'ignore' });
const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
await Promise.all([unlink(keyPath), unlink(certPath)]);
const fingerprint = new X509Certificate(cert).fingerprint256;
const lighting = 'Fixture light settings.\n';
let requestCount = 0;
const server = createServer({ key, cert }, (request, response) => {
  const route = new URL(request.url, 'https://127.0.0.1').pathname;
  response.setHeader('Cache-Control', 'no-store');
  if (route === '/sign-in') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'lighting_session=signed-in; Max-Age=86400; HttpOnly; Secure; SameSite=Lax; Path=/',
    });
    return response.end('<!doctype html><title>Lighting sign-in</title><h1>Signed in through the window</h1>');
  }
  if (route === '/download' || route === '/oversize' || route === '/chunked') {
    response.setHeader('Content-Disposition', 'attachment; filename="lighting.txt"');
    response.setHeader('Content-Type', 'text/plain');
    if (route === '/oversize') {
      const length = 33 * 1024 * 1024;
      response.setHeader('Content-Length', String(length));
      return response.end(Buffer.alloc(length, 65));
    }
    else if (route === '/chunked') response.setHeader('Transfer-Encoding', 'chunked');
    else response.setHeader('Content-Length', String(Buffer.byteLength(lighting)));
    return response.end(lighting);
  }
  if (route === '/redirect') {
    response.writeHead(302, { Location: 'http://127.0.0.1:' + server.address().port + '/unsafe' });
    return response.end();
  }
  if (route === '/expired') {
    response.writeHead(401, { 'Content-Type': 'text/html' });
    return response.end('<h1>Session expired</h1>');
  }
  if (route === '/unsafe') throw new Error('The HTTP redirect must never reach the fixture');
  requestCount++;
  const account = request.headers.cookie?.includes('lighting_session=signed-in') ? 'Signed in' : 'Guest';
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Studio lighting</title><h1>Studio lighting</h1><p id="account">' + account +
    '</p><a href="/reference">Reference page</a> <a target="_blank" href="/sign-in">Sign in separately</a> ' +
    '<a href="/download">Download lighting notes</a> <a href="/oversize">Large file</a> ' +
    '<a href="/chunked">Unknown-length file</a> <a href="/redirect">Insecure redirect</a>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'https://127.0.0.1:' + server.address().port;
const button = (page, name) => page.getByRole('button', { name, exact: true });
const invoke = (page, name, data) => page.evaluate(([name, data]) => window.forge.project[name](data), [name, data]);
const quote = 'Use a soft key light from the left.\nПроверить баланс белого.';
function value(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.value;
}
const view = page => invoke(page, 'view').then(value);

async function launch() {
  const app = await _electron.launch({
    executablePath, args: [root],
    env: {
      ...process.env, FORGE_QUALIFICATION: '1', FORGE_QUALIFICATION_DATA: profileDirectory,
      FORGE_FIXTURE_ORIGIN: origin, FORGE_FIXTURE_CERTIFICATE_FINGERPRINT: fingerprint,
    },
  });
  await app.evaluate(({ dialog }, paths) => {
    globalThis.forgeSiteDestination = paths.savedDownload;
    globalThis.forgeSiteBrowse = paths.project;
    globalThis.forgeSiteConfirm = 1;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.forgeSiteBrowse] });
    dialog.showSaveDialog = async () => globalThis.forgeSiteDestination
      ? ({ canceled: false, filePath: globalThis.forgeSiteDestination })
      : ({ canceled: true });
    dialog.showMessageBox = async (_window, options) => {
      assertDialog(options.defaultId === 0 && options.cancelId === 0 && options.buttons[0] === 'Cancel');
      return { response: globalThis.forgeSiteConfirm };
    };
    function assertDialog(valid) { if (!valid) throw new Error('Clear must default to cancellation'); }
  }, { project, savedDownload });
  (await app.firstWindow()).setDefaultTimeout(8_000);
  return app;
}

function native(app, expression, userGesture = false) {
  return app.evaluate(async ({ BrowserWindow }, { expression, userGesture }) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.getParentWindow());
    const browser = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents);
    return browser?.webContents.executeJavaScript(expression, userGesture) ?? null;
  }, { expression, userGesture });
}

const account = app => native(app, 'document.querySelector("#account")?.textContent ?? null');
const siteStorage = app => app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find(item => !item.getParentWindow());
  const browser = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents);
  return browser.webContents.session.storagePath;
});

async function clickLink(app, href) {
  const selector = JSON.stringify('a[href="' + href + '"]');
  await native(app, 'document.querySelector(' + selector + ').click()', true);
}

async function go(page, address) {
  await page.getByRole('textbox', { name: 'HTTPS address' }).fill(address);
  await button(page, 'Go').click();
}

async function openExisting(page, id) {
  await page.locator('.react-flow__node[data-id="' + id + '"]').dblclick();
  await expect(page.getByRole('textbox', { name: 'HTTPS address' })).toBeEnabled();
}

async function capture(app, page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const captures = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.getParentWindow());
    const browser = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents);
    const results = await Promise.all([window.webContents, browser.webContents].map(contents =>
      contents.capturePage(undefined, { stayHidden: true, stayAwake: true })));
    if (results.some(image => image.isEmpty())) throw new Error('Site capture is empty');
    return results.map(image => image.toPNG().toString('base64'));
  });
  await Promise.all([chromeScreenshot, pageScreenshot].map((file, index) => writeFile(file, Buffer.from(captures[index], 'base64'))));
}

let app;
let firstId;
let firstPlainId;
let secondId;
let projectId;
try {
  app = await launch();
  let page = await app.firstWindow();
  await button(page, 'Projects').click();
  await page.getByLabel('Project name').fill('Studio lighting reference');
  await button(page, 'Create project').click();
  await button(page, 'Add Site').click();
  ({ space: { projectId, nodes: [{ id: firstId, content: { plainId: firstPlainId } }] } } = await view(page));
  assert.equal(await account(app), null);
  await button(page, 'Open Site').click();
  await go(page, origin + '/?source=fixture#dev-only');
  await expect.poll(() => account(app)).toBe('Guest');
  assert.deepEqual(await native(app, '({require: typeof require, process: typeof process, bridge: typeof window.forge})'),
    { require: 'undefined', process: 'undefined', bridge: 'undefined' });

  await clickLink(app, '/reference');
  const address = page.getByRole('textbox', { name: 'HTTPS address' });
  await expect(address).toHaveValue(origin + '/reference');
  await button(page, 'Back').click();
  await expect(address).toHaveValue(origin + '/?source=fixture#dev-only');
  await button(page, 'Forward').click();
  await expect(address).toHaveValue(origin + '/reference');
  const beforeReload = requestCount;
  await button(page, 'Reload').click();
  await expect.poll(() => requestCount).toBeGreaterThan(beforeReload);
  await go(page, 'http://127.0.0.1/');
  await expect(page.getByRole('alert').filter({ hasText: 'Only HTTPS pages' })).toBeVisible();
  await go(page, origin + '/expired');
  await expect(page.getByRole('alert').filter({ hasText: 'requires sign-in' })).toBeVisible();
  await go(page, origin + '/?source=fixture#dev-only');
  await expect.poll(() => account(app)).toBe('Guest');
  await clickLink(app, '/redirect');
  await expect(page.getByRole('alert').filter({ hasText: 'Only HTTPS pages' })).toBeVisible();

  await clickLink(app, '/sign-in');
  await expect(page.getByText('Open a sign-in window for')).toContainText(origin);
  await button(page, 'Open sign-in window').click();
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
    const popup = BrowserWindow.getAllWindows().find(window => window.getParentWindow());
    return popup?.webContents.executeJavaScript('document.querySelector("h1")?.textContent') ?? null;
  })).toBe('Signed in through the window');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getParentWindow()).close());
  await expect(page.getByText(/Sign-in window closed/)).toBeVisible();
  await button(page, 'Reload').click();
  await expect.poll(() => account(app)).toBe('Signed in');

  for (const href of ['/oversize', '/chunked']) {
    await clickLink(app, href);
    await expect(page.getByRole('alert').filter({ hasText: 'known length of 1 byte to 32 MiB' })).toBeVisible();
  }
  await app.evaluate(() => { globalThis.forgeSiteDestination = null; });
  await clickLink(app, '/download');
  await button(page, 'Save download').click();
  await expect(page.getByText(/Site download canceled/)).toBeVisible();
  await assert.rejects(stat(savedDownload), { code: 'ENOENT' });
  await app.evaluate((_electron, file) => { globalThis.forgeSiteDestination = file; }, savedDownload);
  await clickLink(app, '/download');
  await expect(page.getByText('lighting.txt', { exact: true })).toBeVisible();
  await assert.rejects(stat(savedDownload), { code: 'ENOENT' });
  await button(page, 'Save download').click();
  await expect(page.getByText(/Site download saved/)).toBeVisible();
  assert.equal(await readFile(savedDownload, 'utf8'), lighting);
  if (process.platform === 'win32') assert.match(await readFile(savedDownload + ':Zone.Identifier', 'utf8'), /ZoneId=3/);
  await clickLink(app, '/download');
  await button(page, 'Save download').click();
  await expect(page.getByRole('alert').filter({ hasText: 'A file already exists' })).toBeVisible();
  assert.equal(await readFile(savedDownload, 'utf8'), lighting);
  await button(page, 'Dismiss download status').click();
  await expect(page.getByRole('alert').filter({ hasText: 'A file already exists' })).toHaveCount(0);

  await go(page, origin + '/reference?token=synthetic-do-not-store#private');
  await expect(address).toHaveValue(origin + '/reference?token=synthetic-do-not-store#private');
  await button(page, 'Capture current page').click();
  const preview = page.getByRole('region', { name: 'Reference preview' });
  await expect(preview.getByText(origin + '/reference', { exact: true })).toBeVisible();
  await preview.getByLabel('Manual quote').fill(quote);
  await button(page, 'Back to Space').click();
  await expect(page.getByText(/Save or discard the file changes/)).toBeVisible();
  await button(page, 'Save reference').click();
  await expect(page.getByText('Site reference saved.', { exact: true })).toBeVisible();
  const reference = { url: origin + '/reference', title: 'Studio lighting', quote };
  const stored = (await view(page)).space.nodes.find(node => node.id === firstId).content.payload;
  assert.deepEqual(JSON.parse(stored), { reference });
  assert.doesNotMatch(stored, /token|private|lighting_session/);
  await go(page, reference.url);
  await expect(page.getByText('Page loaded.', { exact: true })).toBeVisible();
  const firstStore = await siteStorage(app);
  await capture(app, page);
  await button(page, 'Back to Space').click();
  await expect.poll(() => account(app)).toBe(null);
  await expect(page.getByText(/Studio lighting · .* · Reference saved/)).toBeVisible();
  await button(page, 'Add Site').click();
  secondId = (await view(page)).space.nodes.find(node => node.id !== firstId).id;
  await button(page, 'Open Site').click();
  await go(page, origin + '/');
  await expect.poll(() => account(app)).toBe('Guest');
  await clickLink(app, '/sign-in');
  await button(page, 'Open sign-in window').click();
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
    const popup = BrowserWindow.getAllWindows().find(window => window.getParentWindow());
    return popup?.webContents.executeJavaScript('document.querySelector("h1")?.textContent') ?? null;
  })).toBe('Signed in through the window');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getParentWindow()).close());
  await expect(page.getByText(/Sign-in window closed/)).toBeVisible();
  await app.close();

  const legacyStore = path.join(profileDirectory, 'Partitions', 'forge-site-' + projectId + '-' + firstPlainId);
  if (useLongProfile) {
    assert.ok(path.join(legacyStore, 'Cookies-journal').length >= 260);
    assert.equal(path.dirname(firstStore), path.join(profileDirectory, 'Sites'));
    await mkdir(path.dirname(legacyStore), { recursive: true });
    await rename(firstStore, legacyStore);
  }

  app = await launch();
  page = await app.firstWindow();
  await button(page, 'Projects').click();
  await button(page, 'Studio lighting reference').click();
  await openExisting(page, firstId);
  await expect.poll(() => account(app)).toBe('Signed in');
  assert.equal(await siteStorage(app), firstStore);
  if (useLongProfile) await assert.rejects(stat(legacyStore), { code: 'ENOENT' });
  await page.getByText('Saved reference', { exact: true }).click();
  await expect(page.getByText('Проверить баланс белого.', { exact: false })).toBeVisible();
  await app.evaluate(() => { globalThis.forgeSiteConfirm = 0; });
  await button(page, 'Clear site data').click();
  assert.equal(await account(app), 'Signed in');
  await app.evaluate(() => { globalThis.forgeSiteConfirm = 1; });
  await button(page, 'Clear site data').click();
  await expect(page.getByText(/Site data cleared/)).toBeVisible();
  assert.equal(await account(app), null);
  await go(page, origin + '/');
  await expect.poll(() => account(app)).toBe('Guest');
  await button(page, 'Back to Space').click();
  await openExisting(page, secondId);
  await go(page, origin + '/');
  await expect.poll(() => account(app)).toBe('Signed in');
  const offline = createServer({ key, cert });
  offline.listen(0, '127.0.0.1');
  await once(offline, 'listening');
  const offlineAddress = 'https://127.0.0.1:' + offline.address().port + '/';
  await new Promise((resolve, reject) => offline.close(error => error ? reject(error) : resolve()));
  await go(page, offlineAddress);
  await expect(page.getByRole('alert').filter({ hasText: 'Site is unreachable' })).toBeVisible();

  await button(page, 'Back to Space').click();
  await app.evaluate((_electron, file) => { globalThis.forgeSiteDestination = file; }, archive);
  const current = await view(page);
  value(await invoke(page, 'exportBackup', { projectId, baseRevision: current.revision }));
  await app.evaluate((_electron, file) => { globalThis.forgeSiteBrowse = file; }, archive);
  const { token } = value(await invoke(page, 'inspectBackup'));
  await app.evaluate((_electron, dir) => { globalThis.forgeSiteBrowse = dir; }, run);
  const { projectId: restoredId, folder } = value(await invoke(page, 'restoreBackup', token));
  assert.notEqual(restoredId, projectId);
  const restored = value(await invoke(page, 'openRecent', restoredId));
  assert.deepEqual(JSON.parse(restored.space.nodes.find(node => node.id === firstId).content.payload), { reference });
  await button(page, 'Projects').click();
  await app.evaluate((_electron, dir) => { globalThis.forgeSiteBrowse = dir; }, path.join(run, folder));
  await button(page, 'Open project').click();
  assert.equal((await view(page)).space.projectId, restoredId);
  await openExisting(page, secondId);
  await go(page, origin + '/');
  await expect.poll(() => account(app)).toBe('Guest');
  const archiveBytes = await readFile(archive);
  assert.doesNotMatch(archiveBytes.toString('latin1'), /lighting_session|synthetic-do-not-store/);
  console.log(JSON.stringify({
    outcome: 'PASS', run, profilePathLength: profileDirectory.length, migratedLongProfile: useLongProfile,
    chromeScreenshot, pageScreenshot,
    nativeViewMountedOnlyInPlain: true,
    backForwardReload: true, forbiddenRedirect: true, offlineAndExpiredVisible: true, approvedSignInWindow: true,
    profilesPersistAndClearIndividually: true, checkedDownloadBytesAndMark: true, refusedUnknownAndOversized: true,
    canceledAndOccupiedDestinationPreserved: true, sanitizedReferenceRoundTrip: true, frameworkIsolated: true,
    coreSha256: createHash('sha256').update(await readFile(path.join(root, '.local/bin/forge-core.exe'))).digest('hex'),
  }, null, 2));
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

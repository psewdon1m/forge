import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedSiteUrl, denySitePermissions, siteReference, siteViewOptions } from '../apps/desktop/site-policy.mjs';

test('Site navigation requires HTTPS and excludes embedded credentials', () => {
  const fixture = 'http://127.0.0.1:8123';
  assert.equal(allowedSiteUrl('https://example.test/'), 'https://example.test/');
  for (const url of [fixture, 'file:///C:/Windows/', 'data:text/html,content', 'https://user:pass@example.test/', 'broken']) {
    assert.equal(allowedSiteUrl(url), null);
  }
});

test('a Site partition has no Node integration or bridge preload', () => {
  const { webPreferences: preferences } = siteViewOptions('persist:test');
  assert.equal(preferences.partition, 'persist:test');
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.preload, undefined);
  assert.equal(preferences.disableDialogs, true);
  assert.equal(preferences.disableHtmlFullscreenWindowResize, true);
});

test('a saved Site reference strips query and fragment and bounds plain title', () => {
  assert.deepEqual(siteReference('https://example.test/reference?token=example#private', 'Lighting\u0000plan'), {
    url: 'https://example.test/reference', title: 'Lighting plan',
  });
});

test('a Site session denies permission, device and screen-capture requests', () => {
  const handlers = {};
  denySitePermissions({
    setPermissionCheckHandler(handler) { handlers.check = handler; },
    setPermissionRequestHandler(handler) { handlers.request = handler; },
    setDevicePermissionHandler(handler) { handlers.device = handler; },
    setDisplayMediaRequestHandler(handler) { handlers.display = handler; },
  });
  assert.equal(handlers.check(), false);
  assert.equal(handlers.device(), false);
  handlers.request({}, 'media', granted => assert.equal(granted, false));
  handlers.display({}, streams => assert.equal(streams, null));
});

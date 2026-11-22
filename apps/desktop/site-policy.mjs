export function allowedSiteUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' && url.href.length <= 4096) return url.href;
  } catch {
    return null;
  }
  return null;
}

export function siteReference(address, pageTitle) {
  const https = allowedSiteUrl(address);
  if (!https) return null;
  const url = new URL(https);
  url.hash = '';
  url.search = '';
  const title = Array.from(pageTitle.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()).slice(0, 256).join('');
  return { url: url.href, title: title || url.hostname };
}

export function siteViewOptions(profile) {
  return {
    webPreferences: {
      session: profile,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      disableDialogs: true,
      disableHtmlFullscreenWindowResize: true,
    },
  };
}

export function denySitePermissions(profile) {
  profile.setPermissionCheckHandler(() => false);
  profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  profile.setDevicePermissionHandler(() => false);
  profile.setDisplayMediaRequestHandler((_request, callback) => callback(null));
}

export async function clearSiteSession(profile) {
  await profile.closeAllConnections();
  await profile.clearData();
  await profile.clearAuthCache();
}

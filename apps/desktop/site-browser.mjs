import { BrowserWindow, WebContentsView, dialog, session } from 'electron';
import { allowedSiteUrl, clearSiteSession, denySitePermissions, siteReference, siteViewOptions } from './site-policy.mjs';
import { SiteDownloads } from './site-downloads.mjs';

const clearing = new Set();
const externalError = 'Only HTTPS pages without embedded credentials can open in Site.';

function navigationFailure(code, description) {
  if (code === -106 || code === -102 || code === -105 || code === -109 || code === -118) {
    return 'Site is unreachable. Check the connection and reload.';
  }
  if (description.startsWith('ERR_CERT_')) return 'The site certificate could not be verified.';
  return 'The page could not load. Check the address or reload.';
}

export class SiteBrowser {
  #window;
  #partition;
  #profile;
  #view;
  #update;
  #bounds;
  #popup;
  #candidate;
  #downloads;
  #closed = false;
  #clearing = false;
  #state = {
    address: '', title: '', status: 'Enter an HTTPS address to open a page.', level: 'ready',
  };

  constructor(window, { projectId, plainId, profileDirectory, configureTestCertificate, update }) {
    this.#window = window;
    this.#partition = 'persist:forge-site-' + projectId + '-' + plainId;
    this.#profile = session.fromPartition(this.#partition);
    if (clearing.has(this.#partition)) throw new Error('Site is clearing');
    denySitePermissions(this.#profile);
    configureTestCertificate?.(this.#profile);
    this.#update = update;
    this.#downloads = new SiteDownloads(this.#profile, profileDirectory, () => this.#emit());
    window.on('resize', this.#layout);
    this.#emit();
  }

  #emit() {
    if (this.#closed) return;
    const contents = this.#view?.webContents;
    const history = contents?.navigationHistory;
    this.#update({
      ...this.#state,
      canBack: history?.canGoBack() ?? false,
      canForward: history?.canGoForward() ?? false,
      hasPage: Boolean(this.#view),
      loginOrigin: this.#candidate ? new URL(this.#candidate).origin : null,
      loginOpen: Boolean(this.#popup),
      clearing: this.#clearing,
      download: this.#downloads?.state ?? null,
    });
  }

  #layout = () => {
    if (!this.#view) return;
    const { width, height } = this.#window.getContentBounds();
    const box = this.#bounds;
    const x = box && Math.max(0, box.x);
    const y = box && Math.max(0, box.y);
    const viewWidth = box && Math.min(width - x, box.x + box.width - x);
    const viewHeight = box && Math.min(height - y, box.y + box.height - y);
    if (!box || viewWidth < 1 || viewHeight < 1) {
      this.#view.setVisible(false);
      return;
    }
    this.#view.setBounds({ x, y, width: viewWidth, height: viewHeight });
    this.#view.setVisible(true);
  };

  setBounds(bounds) {
    this.#bounds = bounds;
    this.#layout();
  }

  #report(level, status) {
    this.#state = { ...this.#state, level, status };
    this.#emit();
  }

  #protect(contents, popup) {
    const check = event => {
      if (allowedSiteUrl(event.url) || (!event.isMainFrame && event.url === 'about:blank')) return;
      event.preventDefault();
      if (event.isMainFrame) this.#report('error', externalError);
    };
    contents.on('will-frame-navigate', check);
    contents.on('will-redirect', check);
    contents.setWindowOpenHandler(({ url }) => {
      const candidate = allowedSiteUrl(url);
      if (candidate && !popup && !this.#popup) {
        this.#candidate = candidate;
        this.#report('ready', 'A sign-in or new page request is available.');
      } else {
        this.#report('error', 'Site blocked a new window.');
      }
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', event => event.preventDefault());
  }

  #makeView() {
    const view = new WebContentsView(siteViewOptions(this.#partition));
    this.#view = view;
    const contents = view.webContents;
    const active = () => !this.#closed && this.#view === view;
    view.setVisible(false);
    this.#window.contentView.addChildView(view);
    this.#protect(contents, false);
    this.#downloads.acceptFrom(contents);
    contents.on('did-start-navigation', event => {
      if (!active() || !event.isMainFrame || event.isSameDocument) return;
      this.#candidate = undefined;
      this.#report('loading', 'Loading page…');
    });
    contents.on('did-navigate', (_event, address, code) => {
      if (!active() || !allowedSiteUrl(address)) return;
      this.#state.address = address;
      this.#state.title = '';
      if (code === 401 || code === 403) this.#report('error', 'The site requires sign-in or denied access.');
      else if (code >= 400) this.#report('error', 'The site returned HTTP ' + code + '.');
      else this.#report('ready', 'Page loaded.');
    });
    contents.on('did-navigate-in-page', (_event, address, isMainFrame) => {
      if (!active() || !isMainFrame || !allowedSiteUrl(address)) return;
      this.#state.address = address;
      this.#emit();
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!active()) return;
      this.#state.title = siteReference(this.#state.address, title)?.title ?? '';
      this.#emit();
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!active() || !isMainFrame || code === -3) return;
      this.#report('error', navigationFailure(code, description));
    });
    contents.on('did-stop-loading', () => {
      if (!active()) return;
      if (this.#state.level === 'loading') this.#report('ready', 'Navigation stopped.');
      else this.#emit();
    });
    contents.on('render-process-gone', () => {
      if (!active()) return;
      this.#removeView();
      this.#report('error', 'The page process closed. Open the address again.');
    });
    this.#layout();
    return contents;
  }

  navigate(address) {
    if (this.#closed || this.#clearing) return;
    const url = allowedSiteUrl(address);
    if (!url) {
      this.#report('error', externalError);
      return;
    }
    const contents = this.#view?.webContents ?? this.#makeView();
    void contents.loadURL(url).catch(error => {
      if (!this.#closed && this.#view?.webContents === contents && this.#state.level === 'loading' && error.code !== 'ERR_ABORTED') {
        this.#report('error', navigationFailure(Number(error.errno), String(error.code ?? '')));
      }
    });
  }

  history(action) {
    if (this.#closed || this.#clearing || !this.#view) return;
    const contents = this.#view.webContents;
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    if (action === 'forward' && history.canGoForward()) history.goForward();
    if (action === 'reload') contents.reload();
  }

  startLogin() {
    if (this.#closed || this.#clearing || this.#popup || !this.#candidate) return false;
    const url = this.#candidate;
    this.#candidate = undefined;
    const popup = new BrowserWindow({
      ...siteViewOptions(this.#partition),
      parent: this.#window, modal: true, autoHideMenuBar: true,
      title: 'Forge Site sign-in', width: 780, height: 670,
      show: this.#window.isVisible(),
    });
    this.#popup = popup;
    popup.removeMenu();
    this.#protect(popup.webContents, true);
    const setTitle = address => {
      const target = allowedSiteUrl(address);
      if (target && !popup.isDestroyed()) popup.setTitle('Forge Site sign-in · ' + new URL(target).origin);
    };
    popup.on('page-title-updated', event => event.preventDefault());
    popup.webContents.on('did-navigate', (_event, address, code) => {
      setTitle(address);
      if (code === 401 || code === 403) this.#report('error', 'The sign-in window needs authorization or denied access.');
    });
    popup.webContents.on('did-fail-load', (_event, code, reason, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.#report('error', navigationFailure(code, reason));
    });
    popup.once('closed', () => {
      if (this.#popup !== popup) return;
      this.#popup = undefined;
      this.#report('ready', 'Sign-in window closed. Reload the page to check the session.');
    });
    setTitle(url);
    this.#emit();
    void popup.loadURL(url).catch(() => {});
    return true;
  }

  discardLogin() {
    this.#candidate = undefined;
    this.#report('ready', 'Window request dismissed.');
  }

  reference() {
    const contents = this.#view?.webContents;
    if (!contents || this.#clearing || this.#state.level !== 'ready' || contents.isLoadingMainFrame()) return null;
    return siteReference(contents.getURL(), contents.getTitle());
  }

  saveDownload() {
    return this.#downloads.save(this.#window);
  }

  cancelDownload() {
    this.#downloads.cancel();
  }

  dismissDownload() {
    this.#downloads.dismiss();
  }

  async clear() {
    if (this.#closed || this.#clearing) return false;
    const response = await dialog.showMessageBox(this.#window, {
      type: 'question', message: 'Clear data for this Site?',
      detail: 'This removes its saved session and local website data. Sign in again to use the site.',
      buttons: ['Cancel', 'Clear site data'], cancelId: 0, defaultId: 0, noLink: true,
    });
    if (response.response !== 1 || this.#closed || this.#clearing) return false;
    this.#clearing = true;
    clearing.add(this.#partition);
    this.#candidate = undefined;
    this.#closePopup();
    this.#downloads.cancel();
    this.#removeView();
    this.#state = { address: '', title: '', status: 'Clearing site data…', level: 'loading' };
    this.#emit();
    try {
      await clearSiteSession(this.#profile);
      this.#report('ready', 'Site data cleared. Open the address and sign in again.');
      return true;
    } catch {
      this.#report('error', 'Site data could not be fully cleared. Try Clear site data again.');
      return false;
    } finally {
      this.#clearing = false;
      clearing.delete(this.#partition);
      this.#emit();
    }
  }

  #removeView() {
    const view = this.#view;
    if (!view) return;
    this.#view = undefined;
    this.#downloads.acceptFrom(undefined);
    if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  #closePopup() {
    const popup = this.#popup;
    this.#popup = undefined;
    if (popup && !popup.isDestroyed()) popup.destroy();
  }

  close() {
    this.#closed = true;
    this.#window.off('resize', this.#layout);
    this.#downloads.close();
    this.#closePopup();
    this.#removeView();
  }
}

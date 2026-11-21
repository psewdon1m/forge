import { app, BrowserWindow, WebContentsView, dialog, ipcMain, protocol, session, shell } from 'electron';
import { X509Certificate, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreClient } from './core-client.mjs';
import { AssetOpen, audioScheme, imageScheme, videoScheme } from './asset-open.mjs';
import { DocumentEdits, chooseDocumentEditor, documentEditorFormat } from './document-edits.mjs';
import { GitBindings } from './git-bindings.mjs';
import { RecentProjects } from './recent-projects.mjs';
import { DesktopDiagnostics } from './diagnostics.mjs';
import { Intelligent } from './intelligent.mjs';
import { Transcription } from './transcription.mjs';
import { allowedSiteUrl, clearSiteSession, denySitePermissions, siteViewOptions } from './site-policy.mjs';
import { SiteBrowser } from './site-browser.mjs';
import { sweepSiteDownloads } from './site-downloads.mjs';
import { DesktopUpdates } from './updates.mjs';
import { completeStartup, readStartupChallenge, watchStartup } from './update-startup.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(root, 'dist', 'index.html');
const coreExecutable = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'forge-core.exe')
  : path.join(root, '.local', 'bin', 'forge-core.exe');
const fixtureMode = !app.isPackaged && process.env.FORGE_QUALIFICATION === '1';
const offscreenBenchmark = fixtureMode && process.env.FORGE_CANVAS_FIXTURE === '500';
const qualifierDirectory = fixtureMode ? process.env.FORGE_QUALIFICATION_DATA : undefined;
const installation = app.isPackaged ? process.env.FORGE_INSTALLATION_ROOT : undefined;
const startupChallenge = readStartupChallenge(installation, app.getVersion());
const startupBarrier = startupChallenge ? Promise.withResolvers() : null;
if (qualifierDirectory) app.setPath('userData', qualifierDirectory);
if (installation) {
  if (!path.isAbsolute(installation)) throw new Error('Invalid Forge installation path');
  const profile = path.join(path.dirname(installation), 'Profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  if (!app.requestSingleInstanceLock()) app.exit(1);
}
const stopStartupWatch = startupChallenge ? watchStartup(startupChallenge.supervisorPid, () => app.exit(1)) : undefined;
const recentProjects = new RecentProjects(app.getPath('userData'));
const gitBindings = new GitBindings(app.getPath('userData'));
const assetOpen = new AssetOpen(app.getPath('userData'));
const documentEdits = new DocumentEdits(app.getPath('userData'));
const desktopUpdates = new DesktopUpdates({
  installation,
  executable: process.execPath,
  installed: app.getVersion(),
});
protocol.registerSchemesAsPrivileged([imageScheme, audioScheme, videoScheme].map(scheme => ({
  scheme, privileges: { standard: true, secure: true, stream: true, corsEnabled: scheme === videoScheme },
})));

let window;
let site;
let lastSitePopup;
let lastSiteDownload;
let activeSite;
let core;
let openedDirectory;
let openedProjectId;
const intelligent = new Intelligent({
  prepare: request => core.request({ kind: 'modelContext', request }), currentProject: () => openedProjectId,
  fixturePort: fixtureMode ? Number(process.env.FORGE_QUALIFICATION_OLLAMA_PORT) : undefined,
});
const transcription = new Transcription({
  prepare: (request, destination, operationId) => core.request({ kind: 'researchTranscription', request, destination, operationId }),
  currentProject: () => openedProjectId,
  copy: exportAudio => assetOpen.copy('wav', exportAudio),
  discard: directory => assetOpen.discard(directory),
  cancelCopy: operationId => core.cancelAnalysis(operationId),
  fixturePort: fixtureMode ? Number(process.env.FORGE_QUALIFICATION_TRANSCRIPTION_PORT) : undefined,
});
let choosingDirectory = false;
let pendingDrop;
let activeImport;
let activeAnalysis;
let inspectedBackup;
let inspectedSettingsBackup;
let settingsReady;
let restartingForUpdate = false;
const diagnostics = new DesktopDiagnostics(coreExecutable, app.getPath('userData'), health => {
  if (window && !window.isDestroyed()) window.webContents.send('forge:diagnostics:health', health);
});

function primaryFrame(frame) {
  if (!frame || frame.parent) return false;
  try {
    const url = new URL(frame.url);
    return url.protocol === 'file:' && fileURLToPath(url) === entry;
  } catch {
    return false;
  }
}

function trustedFrame(event) {
  return event.sender === window?.webContents && primaryFrame(event.senderFrame);
}

function bridge(command, handler, { needsCore = true } = {}) {
  ipcMain.handle('forge:project:' + command, async (event, payload) => {
    if (startupBarrier) await startupBarrier.promise;
    if (!trustedFrame(event)) {
      void diagnostics.deny();
      return projectError('FORBIDDEN', 'This frame cannot access Forge projects.');
    }
    const previousProjectId = openedProjectId;
    let reply;
    try {
      if (needsCore && !existsSync(coreExecutable)) {
        reply = projectError('CORE_UNAVAILABLE', 'Build Forge Core before working with local projects.');
      } else {
        if (needsCore) core ??= new CoreClient(coreExecutable);
        reply = await handler(payload);
      }
    } catch {
      reply = projectError('CORE_UNAVAILABLE', 'Forge Core is not responding.');
    }
    return diagnostics.observe(command, previousProjectId, reply);
  });
}

function projectError(code, message) {
  return { ok: false, error: { code, message } };
}

bridge('update-status', async () => ({ ok: true, value: await desktopUpdates.status() }), { needsCore: false });
bridge('check-updates', async () => {
  const status = await desktopUpdates.check();
  if (status.state !== 'error') return { ok: true, value: status };
  const correlationId = await diagnostics.recordUpdateMetadata('update-check', status);
  return { ok: true, value: { ...status, correlationId } };
}, { needsCore: false });

async function restartForUpdate(id, backup, rollback = false) {
  try {
    await desktopUpdates.restart(id, backup, rollback);
    restartingForUpdate = true;
    setImmediate(() => app.quit());
    return { ok: true, value: null };
  } catch (error) {
    if (error.code === 'ROLLBACK_BACKUP_INVALID') {
      return projectError('ROLLBACK_BACKUP_INVALID', 'Choose the original ZIP saved for this update.');
    }
    if (rollback) return projectError('UPDATE_ROLLBACK_FAILED', 'Forge Launcher could not accept the rollback. Review the update job and retry.');
    return projectError('UPDATE_RESTART_FAILED', 'Forge Launcher could not start the update. Check the prepared job and its backup.');
  }
}

bridge('stage-update', async input => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current operation to finish.');
  if (!input || !desktopUpdates.canStage(input)) {
    return projectError('INVALID_INPUT', 'Check for updates and select the verified release.');
  }
  choosingDirectory = true;
  try {
    const selected = await dialog.showSaveDialog(window, {
      title: 'Save update backup',
      defaultPath: `Forge-${app.getVersion()}-before-${input.version}.zip`,
      filters: [{ name: 'Forge backup', extensions: ['zip'] }],
    });
    if (selected.canceled || !selected.filePath) return { ok: true, value: null };
    const job = await desktopUpdates.stage(input, selected.filePath);
    if (job.rejection) {
      const correlationId = await diagnostics.recordUpdateMetadata('update-stage', job.rejection);
      return { ok: false, error: { code: 'UPDATE_METADATA_REJECTED', message: job.rejection.message, correlationId } };
    }
    await diagnostics.recordUpdate(job);
    if (job.phase === 'staged') {
      const restart = await restartForUpdate(job.id, selected.filePath);
      if (!restart.ok) return restart;
    }
    return { ok: true, value: job };
  } catch {
    return projectError('UPDATE_PREPARATION_FAILED', 'Forge could not confirm preparation. Check for updates and try again.');
  } finally {
    if (!restartingForUpdate) choosingDirectory = false;
  }
}, { needsCore: false });

async function chooseUpdateBackupAndRestart(id, rollback) {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current operation to finish.');
  choosingDirectory = true;
  try {
    const status = await desktopUpdates.status();
    const job = status.lastJob;
    if (!job || job.id !== id || (rollback ? !job.canRollBack : job.phase !== 'staged')) {
      return projectError('INVALID_INPUT', rollback ? 'Select a completed update with a verified previous version.' : 'Select the current prepared update.');
    }
    const selected = await dialog.showOpenDialog(window, {
      title: 'Open the original update backup', properties: ['openFile'],
      filters: [{ name: 'Forge backup', extensions: ['zip'] }],
    });
    if (selected.canceled || selected.filePaths.length !== 1) return { ok: true, value: null };
    return await restartForUpdate(id, selected.filePaths[0], rollback);
  } finally {
    if (!restartingForUpdate) choosingDirectory = false;
  }
}

bridge('restart-update', id => chooseUpdateBackupAndRestart(id, false), { needsCore: false });
bridge('rollback-update', id => chooseUpdateBackupAndRestart(id, true), { needsCore: false });

async function requestSettings(command) {
  settingsReady ??= core.request({ kind: 'settingsOpen', profile: app.getPath('userData') });
  let initialized;
  try {
    initialized = await settingsReady;
  } catch (error) {
    settingsReady = undefined;
    throw error;
  }
  if (!initialized.ok) {
    settingsReady = undefined;
    return initialized;
  }
  return core.request(command);
}

function settingsArchiveName(file) {
  return path.basename(file).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 255);
}

bridge('settings-read', () => requestSettings({ kind: 'settingsRead' }));
bridge('settings-save', input => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current operation to finish.');
  if (!Number.isSafeInteger(input?.baseRevision) || input.baseRevision < 0 || typeof input.snapToGrid !== 'boolean') {
    return projectError('INVALID_INPUT', 'Choose a valid setting and revision.');
  }
  return requestSettings({
    kind: 'settingsSave', baseRevision: input.baseRevision, preferences: { snapToGrid: input.snapToGrid },
  });
});
bridge('settings-backup-export', async () => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current operation to finish.');
  choosingDirectory = true;
  try {
    const state = await requestSettings({ kind: 'settingsRead' });
    if (!state.ok) return state;
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const selected = await dialog.showSaveDialog(window, {
      title: 'Export Forge settings', defaultPath: 'Forge-settings-' + stamp + '.zip',
      filters: [{ name: 'Forge backup', extensions: ['zip'] }],
    });
    if (selected.canceled) return { ok: true, value: null };
    const result = await requestSettings({
      kind: 'settingsBackupExport', destination: selected.filePath, baseRevision: state.value.revision,
    });
    if (!result.ok) return result;
    return { ok: true, value: { name: settingsArchiveName(selected.filePath) } };
  } finally {
    choosingDirectory = false;
  }
});
bridge('settings-backup-inspect', async () => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current operation to finish.');
  choosingDirectory = true;
  inspectedSettingsBackup = undefined;
  try {
    const selected = await dialog.showOpenDialog(window, {
      title: 'Inspect a Forge settings backup', properties: ['openFile'],
      filters: [{ name: 'Forge backup', extensions: ['zip'] }],
    });
    if (selected.canceled) return { ok: true, value: null };
    const archive = selected.filePaths[0];
    const inspected = await core.request({ kind: 'settingsBackupInspect', path: archive });
    if (!inspected.ok) return inspected;
    const state = await requestSettings({ kind: 'settingsRead' });
    if (!state.ok) return state;
    const token = randomUUID();
    const { archiveSha256, ...info } = inspected.value;
    inspectedSettingsBackup = { token, archive, archiveSha256, baseRevision: state.value.revision };
    return { ok: true, value: { token, info: { ...info, name: settingsArchiveName(archive) } } };
  } finally {
    choosingDirectory = false;
  }
});
bridge('settings-backup-restore', async token => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current operation to finish.');
  const selected = inspectedSettingsBackup;
  if (!selected || selected.token !== token) return projectError('BACKUP_SELECTION', 'Inspect the settings archive before restoring.');
  choosingDirectory = true;
  try {
    const answer = await dialog.showMessageBox(window, {
      type: 'question', message: 'Restore Forge settings?',
      detail: 'This replaces the saved application preferences in this profile.',
      buttons: ['Cancel', 'Restore settings'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (answer.response !== 1) return { ok: true, value: null };
    inspectedSettingsBackup = undefined;
    return await requestSettings({
      kind: 'settingsBackupRestore', path: selected.archive, archiveSha256: selected.archiveSha256,
      baseRevision: selected.baseRevision,
    });
  } finally {
    choosingDirectory = false;
  }
});

async function remember(space, directory, result) {
  try {
    await recentProjects.record(space, directory);
  } catch {
    return { ...result, warning: 'The project was saved, but the recent project list could not be updated.' };
  }
  return result;
}

async function openDirectory({ kind, directory, title, expectedProjectId }) {
  const result = kind === 'open' && openedDirectory === directory
    ? await core.request({ kind: 'view' })
    : await core.request({ kind, directory, ...(kind === 'create' ? { title } : { expectedProjectId: expectedProjectId ?? null }) });
  if (!result.ok) return result;
  const { space } = result.value;
  if (expectedProjectId && expectedProjectId !== space.projectId) {
    return projectError('PROJECT_CHANGED', 'This folder now belongs to a different project. Use Open project to choose its location.');
  }
  closeActiveSite();
  openedDirectory = directory;
  openedProjectId = space.projectId;
  intelligent.clear();
  transcription.clear();
  pendingDrop = undefined;
  await assetOpen.clearPreviews();
  return remember(space, directory, result);
}

async function pickDirectory(kind, title) {
  if (kind === 'create' && (typeof title !== 'string' || title.length > 480)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'Enter a project title.' } };
  }
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'A project selection is already in progress.');
  choosingDirectory = true;
  try {
    const choice = await dialog.showOpenDialog(window, {
      title: kind === 'create' ? 'Choose an empty project folder' : 'Open a Forge project folder',
      properties: ['openDirectory'],
    });
    if (choice.canceled) return { ok: true, value: null };
    return await openDirectory({ kind, directory: choice.filePaths[0], title });
  } finally {
    choosingDirectory = false;
  }
}

bridge('create', title => pickDirectory('create', title));
bridge('open', () => pickDirectory('open'));
bridge('recent', async () => ({ ok: true, value: await recentProjects.list() }), { needsCore: false });
bridge('open-recent', async id => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'A project selection is already in progress.');
  choosingDirectory = true;
  try {
    const directory = await recentProjects.directory(id);
    if (!directory) return projectError('PROJECT_NOT_RECENT', 'Choose the project folder using Open project.');
    const result = await openDirectory({ kind: 'open', directory, expectedProjectId: id });
    if (!result.ok && ['PROJECT_IO_ERROR', 'INVALID_INPUT', 'PROJECT_CHANGED'].includes(result.error.code)) {
      return projectError('PROJECT_UNAVAILABLE', 'The saved folder is unavailable or belongs to a different project. Choose its current location using Open project.');
    }
    return result;
  } finally {
    choosingDirectory = false;
  }
});
async function closeProject() {
  const result = await core.request({ kind: 'close' });
  if (result.ok) {
    closeActiveSite();
    openedDirectory = undefined;
    openedProjectId = undefined;
    intelligent.clear();
    transcription.clear();
    pendingDrop = undefined;
    await assetOpen.clearPreviews();
  }
  return result;
}
bridge('close', async () => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for project selection to finish.');
  return closeProject();
});
bridge('archive', async id => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current project operation to finish.');
  if (!openedProjectId || id !== openedProjectId) return projectError('PROJECT_CHANGED', 'Open the project before archiving it.');
  choosingDirectory = true;
  try {
    const confirmation = await dialog.showMessageBox(window, {
      type: 'question', message: 'Archive this project?',
      detail: 'Forge will close the project and remove it from Recent Projects. You can open its existing folder again.',
      buttons: ['Cancel', 'Archive project'], cancelId: 0, defaultId: 0, noLink: true,
    });
    if (confirmation.response !== 1) return { ok: true, value: false };
    try {
      await recentProjects.remove(id);
    } catch {
      return projectError('PROJECT_CATALOG', 'The recent project list could not be saved.');
    }
    const closed = await closeProject();
    if (!closed.ok) return closed;
    return { ok: true, value: true };
  } finally {
    choosingDirectory = false;
  }
});
bridge('view', () => core.request({ kind: 'view' }));
bridge('backup-export', async input => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current project operation to finish.');
  if (!openedProjectId || input?.projectId !== openedProjectId || !Number.isSafeInteger(input.baseRevision)) {
    return projectError('PROJECT_CHANGED', 'Open the project again before exporting it.');
  }
  choosingDirectory = true;
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const choice = await dialog.showSaveDialog(window, {
      title: 'Export project backup', defaultPath: `Forge-${openedProjectId.slice(0, 8)}-${stamp}.zip`,
      filters: [{ name: 'Forge backup', extensions: ['zip'] }],
    });
    if (choice.canceled) return { ok: true, value: null };
    return await core.request({ kind: 'createBackup', destination: choice.filePath, baseRevision: input.baseRevision });
  } finally {
    choosingDirectory = false;
  }
});
bridge('backup-inspect', async () => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current project operation to finish.');
  choosingDirectory = true;
  inspectedBackup = undefined;
  try {
    const choice = await dialog.showOpenDialog(window, {
      title: 'Inspect a Forge project backup', properties: ['openFile'],
      filters: [{ name: 'Forge backup', extensions: ['zip'] }],
    });
    if (choice.canceled) return { ok: true, value: null };
    const archive = choice.filePaths[0];
    const result = await core.request({ kind: 'inspectBackup', path: archive });
    if (!result.ok) return result;
    const token = randomUUID();
    inspectedBackup = { token, archive, sha256: result.value.archiveSha256 };
    return { ok: true, value: { token, info: result.value } };
  } finally {
    choosingDirectory = false;
  }
});
bridge('backup-restore', async token => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current project operation to finish.');
  if (!inspectedBackup || inspectedBackup.token !== token) {
    return projectError('BACKUP_SELECTION', 'Inspect the archive again before restoring it.');
  }
  choosingDirectory = true;
  try {
    const choice = await dialog.showOpenDialog(window, {
      title: 'Choose a parent folder for the restored project', properties: ['openDirectory'],
    });
    if (choice.canceled) return { ok: true, value: null };
    const folder = `Forge restored ${randomUUID().slice(0, 8)}`;
    const directory = path.join(choice.filePaths[0], folder);
    const result = await core.request({
      kind: 'restoreBackup', path: inspectedBackup.archive, archiveSha256: inspectedBackup.sha256, destination: directory,
    });
    if (!result.ok) return result;
    inspectedBackup = undefined;
    return remember(result.value.space, directory, { ok: true, value: { folder, projectId: result.value.space.projectId } });
  } finally {
    choosingDirectory = false;
  }
});
bridge('logs-page', before => diagnostics.page(before ?? null), { needsCore: false });
bridge('logs-export', async () => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current project operation to finish.');
  choosingDirectory = true;
  try {
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const result = await dialog.showSaveDialog(window, {
      title: 'Save Forge diagnostics', defaultPath: 'forge-logs-' + stamp + '.zip',
      filters: [{ name: 'Forge diagnostics', extensions: ['zip'] }],
    });
    if (result.canceled) return { ok: true, value: null };
    const saved = await diagnostics.export(result.filePath, await desktopUpdates.diagnosticContext());
    return saved.ok ? { ok: true, value: true } : saved;
  } finally {
    choosingDirectory = false;
  }
}, { needsCore: false });
bridge('apply', async envelope => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for project selection to finish before saving.');
  if (!openedProjectId || envelope?.projectId !== openedProjectId) {
    return projectError('PROJECT_CHANGED', 'Open the project again before saving.');
  }
  const { projectId: _projectId, ...request } = envelope;
  if (request.change?.kind === 'saveIntelligentResult') return projectError('FORBIDDEN', 'Save a result from its completed review.');
  if (request.change?.kind === 'editResearch' && request.change.action?.kind === 'setProviderTranscript') {
    return projectError('FORBIDDEN', 'Save an automatic transcript from its completed review.');
  }
  const directory = openedDirectory;
  const result = await core.request({ kind: 'apply', request });
  if (result.ok) {
    const change = request.change;
    if (['editGallery', 'archiveNode'].includes(change.kind)) await assetOpen.invalidateVideos(change.id);
    if (['restoreRevision', 'undo', 'redo', 'archiveSelection'].includes(change.kind)) await assetOpen.invalidateVideos();
  }
  if (result.ok && activeSite && (
    ['restoreRevision', 'undo', 'redo'].includes(request?.change?.kind) ||
    (request?.change?.kind === 'archiveNode' && request.change.id === activeSite.nodeId) ||
    (request?.change?.kind === 'archiveSelection' && request.change.ids.includes(activeSite.nodeId))
  )) closeActiveSite();
  if (!result.ok || !directory || !['renameProject', 'restoreRevision', 'undo', 'redo'].includes(request?.change?.kind)) return result;
  const view = await core.request({ kind: 'view' });
  if (view.ok && view.value.space.projectId === envelope.projectId &&
      view.value.revision === result.value.revision && openedDirectory === directory) {
    return remember(view.value.space, directory, result);
  }
  return result;
});
bridge('viewport', input => {
  if (choosingDirectory || !openedProjectId || input?.projectId !== openedProjectId) {
    return projectError('PROJECT_CHANGED', 'Open the project again before saving its view.');
  }
  return core.request({ kind: 'saveViewport', viewport: input.viewport });
});
bridge('history', before => core.request({ kind: 'history', before: before ?? null, limit: 100 }));

function validImportPaths(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.length <= 50 && paths.every(file =>
    typeof file === 'string' && file.length < 32768 && path.isAbsolute(file));
}

bridge('register-drop', paths => {
  if (!openedProjectId || choosingDirectory) return projectError('PROJECT_BUSY', 'Open a project before dropping files.');
  if (!validImportPaths(paths)) return projectError('INVALID_INPUT', 'Drop between 1 and 50 files from the filesystem.');
  const token = randomUUID();
  pendingDrop = { token, projectId: openedProjectId, paths, expiresAt: Date.now() + 30_000 };
  return { ok: true, value: token };
}, { needsCore: false });

bridge('import-assets', async input => {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current project operation to finish.');
  if (!openedProjectId || input?.projectId !== openedProjectId) {
    return projectError('PROJECT_CHANGED', 'Open the project again before importing files.');
  }
  if (typeof input.operationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.operationId)) {
    return projectError('INVALID_INPUT', 'Invalid import operation ID.');
  }
  choosingDirectory = true;
  try {
    let paths;
    if (input.dropToken !== undefined) {
      const drop = pendingDrop;
      if (!drop || drop.token !== input.dropToken || drop.projectId !== openedProjectId || drop.expiresAt < Date.now()) {
        return projectError('INVALID_INPUT', 'The drop has expired. Drop the files again.');
      }
      pendingDrop = undefined;
      paths = drop.paths;
    } else {
      const selected = await dialog.showOpenDialog(window, {
        title: input.galleryId ? 'Import media into Gallery' : 'Import files into Space',
        properties: ['openFile', 'multiSelections'],
        filters: [input.galleryId
          ? { name: 'Gallery media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'webm', 'mp4'] }
          : { name: 'Supported files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'pdf', 'docx', 'wav', 'webm', 'mp4'] }],
      });
      if (selected.canceled) return { ok: true, value: null };
      paths = selected.filePaths;
    }
    if (!validImportPaths(paths)) return projectError('INVALID_INPUT', 'Select between 1 and 50 local files.');
    const operation = { projectId: input.projectId, operationId: input.operationId, committing: false, cancelRequested: false };
    activeImport = operation;
    const imported = await core.request({
      kind: 'importAssets',
      galleryId: input.galleryId,
      request: { operationId: input.operationId, baseRevision: input.baseRevision, paths, position: input.position },
    }, {
      onProgress(progress) {
        operation.committing = progress.phase === 'committing';
        if (window && !window.isDestroyed()) window.webContents.send('forge:project:import-progress', {
          ...progress, operationId: operation.operationId,
        });
      },
    });
    if (input.galleryId && imported.ok && imported.value.items.some(item => item.asset)) {
      await assetOpen.invalidateVideos(input.galleryId);
    }
    return imported;
  } finally {
    activeImport = undefined;
    choosingDirectory = false;
  }
});

bridge('cancel-import', async input => {
  const operation = activeImport;
  if (!operation || input?.operationId !== operation.operationId || input?.projectId !== operation.projectId ||
      operation.committing || operation.cancelRequested) return { ok: true, value: false };
  operation.cancelRequested = true;
  try {
    await core.cancelImport(operation.operationId);
    return { ok: true, value: true };
  } catch (error) {
    operation.cancelRequested = false;
    throw error;
  }
}, { needsCore: false });
function currentAsset(input) {
  if (choosingDirectory) return projectError('PROJECT_BUSY', 'Wait for the current project operation to finish.');
  if (!openedProjectId || input?.projectId !== openedProjectId) {
    return projectError('PROJECT_CHANGED', 'Open the project again before reading its files.');
  }
  return { ok: true };
}

function assetFilter(format) {
  return { name: format.toUpperCase(), extensions: format === 'jpeg' ? ['jpg', 'jpeg'] : [format] };
}

bridge('directory-list', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'directoryList', nodeId: input.nodeId, folder: input.folder });
});

function currentGit(input) {
  const current = currentAsset(input);
  if (!current.ok) return current;
  if (typeof input.nodeId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.nodeId)) {
    return projectError('INVALID_INPUT', 'Open a Git card in this project.');
  }
  return current;
}

bridge('git-bind', async input => {
  const current = currentGit(input);
  if (!current.ok) return current;
  const { projectId, nodeId } = input;
  choosingDirectory = true;
  try {
    const card = await core.request({ kind: 'gitCheck', nodeId });
    if (!card.ok) return card;
    const choice = await dialog.showOpenDialog(window, {
      title: 'Choose the root of a local Git working tree', properties: ['openDirectory'],
    });
    if (choice.canceled) return { ok: true, value: null };
    const binding = await gitBindings.candidate(choice.filePaths[0]);
    if (!binding) return projectError('GIT_REPOSITORY', 'Choose a Git working tree with its own .git directory.');
    const state = await core.request({ kind: 'gitRead', nodeId, repository: binding.directory });
    if (state.ok) await gitBindings.save(projectId, nodeId, binding);
    return state;
  } finally {
    choosingDirectory = false;
  }
});

bridge('git-unbind', async input => {
  const current = currentGit(input);
  if (!current.ok) return current;
  choosingDirectory = true;
  try {
    const { projectId, nodeId } = input;
    const card = await core.request({ kind: 'gitCheck', nodeId });
    if (!card.ok) return card;
    await gitBindings.remove(projectId, nodeId);
    return { ok: true, value: null };
  } finally {
    choosingDirectory = false;
  }
});

async function gitRequest(input, kind, fields = {}) {
  const current = currentGit(input);
  if (!current.ok) return current;
  const { projectId, nodeId } = input;
  const repository = await gitBindings.read(projectId, nodeId);
  const active = currentGit(input);
  if (!active.ok) return active;
  if (!repository) return kind === 'gitRead'
    ? { ok: true, value: null }
    : projectError('GIT_NOT_BOUND', 'Choose a local Git repository for this card.');
  return core.request({ kind, nodeId, repository, ...fields });
}

bridge('git-read', input => gitRequest(input, 'gitRead'));
bridge('git-diff', input => gitRequest(input, 'gitDiff', { path: input?.path, side: input?.side, revision: input?.revision }));
bridge('git-mutate', input => gitRequest(input, 'gitMutate', { revision: input?.revision, action: input?.action }));

bridge('gallery-page', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, sourceRevision, offset, limit } = input;
  return core.request({ kind: 'galleryPage', nodeId, sourceRevision, offset, limit });
});

bridge('gallery-preview', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, sourceRevision, versionId } = input;
  const result = await core.request({ kind: 'galleryPreview', nodeId, sourceRevision, versionId });
  return assetPreviewForRenderer(result);
});

bridge('video-open', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { projectId, nodeId, versionId, sourceRevision, format } = input;
  if (!['webm', 'mp4'].includes(format)) return projectError('INVALID_INPUT', 'Choose a WebM or MP4 video.');
  const seen = assetOpen.videoRevision(nodeId);
  const command = sourceRevision === undefined
    ? { kind: 'exportAsset', nodeId, versionId }
    : { kind: 'exportGalleryVideo', nodeId, versionId, sourceRevision };
  const copy = await assetOpen.copy(format, destination => core.request({ ...command, destination }));
  if (!copy.ok) return copy;
  try {
    const src = await assetOpen.presentVideo(copy.value, format, nodeId);
    if (projectId !== openedProjectId || seen !== assetOpen.videoRevision(nodeId)) {
      await assetOpen.releaseVideo(src);
      return projectError('SOURCE_CHANGED', 'The video source changed. Choose it again.');
    }
    return { ok: true, value: { src } };
  } catch (error) {
    await assetOpen.discard(copy.value.directory);
    throw error;
  }
});

bridge('video-release', async src => {
  await assetOpen.releaseVideo(src);
  return { ok: true, value: null };
}, { needsCore: false });

bridge('linked-assets', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, linkId, sourceRevision, offset, limit } = input;
  return core.request({ kind: 'linkedAssets', targetId, linkId, sourceRevision, offset, limit });
});

bridge('linked-text', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, linkId, sourceRevision } = input;
  return core.request({ kind: 'linkedText', targetId, linkId, sourceRevision });
});

bridge('research-status', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'researchStatus', targetId: input.targetId });
});

bridge('model-review', input => {
  const current = currentAsset(input);
  return current.ok ? intelligent.review(input) : current;
});
bridge('model-send', input => {
  const current = currentAsset(input);
  return current.ok ? intelligent.send(input) : current;
});
bridge('model-cancel', input => intelligent.cancel(input), { needsCore: false });
bridge('model-save', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const result = intelligent.result(input);
  if (!result) return projectError('MODEL_RESULT_UNAVAILABLE', 'The completed result is no longer available to save.');
  return core.request({ kind: 'apply', request: { operationId: input.operationId, baseRevision: input.baseRevision,
    change: { kind: 'saveIntelligentResult', id: input.targetId, result } } });
});

bridge('transcription-review', input => {
  const current = currentAsset(input);
  return current.ok ? transcription.review(input) : current;
});
bridge('transcription-start', input => {
  const current = currentAsset(input);
  return current.ok ? transcription.start(input) : current;
});
bridge('transcription-cancel', input => transcription.cancel(input), { needsCore: false });
bridge('transcription-save', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const result = transcription.result(input);
  if (!result) return projectError('TRANSCRIPTION_RESULT_UNAVAILABLE', 'The completed transcript is unavailable.');
  const action = { kind: 'setProviderTranscript', sourceId: result.sourceId, revision: result.origin.sourceRevision,
    segments: result.segments, origin: result.origin };
  return core.request({ kind: 'apply', request: { operationId: input.operationId, baseRevision: input.baseRevision,
    change: { kind: 'editResearch', id: input.targetId, action } } });
});

bridge('research-preview', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, sourceId, revision } = input;
  return assetPreviewForRenderer(await core.request({ kind: 'researchPreview', targetId, sourceId, revision }));
});

bridge('research-audio', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { projectId, targetId, sourceId, revision } = input;
  const result = await assetOpen.copy('wav', destination => core.request({
    kind: 'exportResearchAudio', projectId, targetId, sourceId, revision, destination,
  }));
  if (!result.ok) return result;
  try {
    const src = await assetOpen.presentAudio(result.value);
    if (openedProjectId !== projectId) {
      await assetOpen.releaseAudio(src);
      return projectError('PROJECT_CHANGED', 'Open the project again before playing its recording.');
    }
    return { ok: true, value: { src } };
  } catch {
    await assetOpen.discard(result.value.directory);
    return projectError('OPEN_IO_ERROR', 'Forge could not prepare the recording for playback.');
  }
});

bridge('release-research-audio', async src => {
  await assetOpen.releaseAudio(src);
  return { ok: true, value: null };
}, { needsCore: false });

bridge('checklist-completions', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, sourceRevision, offset, limit } = input;
  return core.request({ kind: 'checklistCompletions', nodeId, sourceRevision, offset, limit });
});

bridge('dataset-read', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return pickDatasetFile();
});

async function pickDatasetFile() {
  choosingDirectory = true;
  try {
    const pick = await dialog.showOpenDialog(window, {
      title: 'Choose a Dataset file', properties: ['openFile'],
      filters: [{ name: 'CSV or TSV', extensions: ['csv', 'tsv'] }],
    });
    return pick.canceled ? { ok: true, value: null } : await core.request({ kind: 'datasetRead', path: pick.filePaths[0] });
  } finally {
    choosingDirectory = false;
  }
}

bridge('dataset-preview', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { text, options } = input;
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 512 * 1024) {
    return projectError('DATASET_LIMIT', 'CSV and TSV input is limited to 512 KiB.');
  }
  return core.request({ kind: 'datasetPreview', text, options });
});

bridge('dataset-page', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, query } = input;
  return core.request({ kind: 'datasetPage', nodeId, query });
});

bridge('dataset-export', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, sourceRevision, delimiter } = input;
  if (!['comma', 'tab'].includes(delimiter) || typeof sourceRevision !== 'string'
      || !/^[a-f0-9]{64}$/.test(sourceRevision)) {
    return projectError('INVALID_INPUT', 'Choose a saved Dataset and an export delimiter.');
  }
  const extension = delimiter === 'comma' ? 'csv' : 'tsv';
  choosingDirectory = true;
  try {
    const pick = await dialog.showSaveDialog(window, {
      title: 'Export Dataset', defaultPath: 'Dataset.' + extension,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (pick.canceled) return { ok: true, value: false };
    const saved = await core.request({ kind: 'datasetExport', nodeId, sourceRevision, delimiter, destination: pick.filePath });
    return saved.ok ? { ok: true, value: true } : saved;
  } finally {
    choosingDirectory = false;
  }
});

bridge('scheme-read', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  choosingDirectory = true;
  try {
    const pick = await dialog.showOpenDialog(window, {
      title: 'Open Scheme JSON', properties: ['openFile'],
      filters: [{ name: 'Scheme JSON', extensions: ['json'] }],
    });
    return pick.canceled ? { ok: true, value: null }
      : await core.request({ kind: 'schemeRead', path: pick.filePaths[0] });
  } finally {
    choosingDirectory = false;
  }
});

bridge('scheme-graph', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, sourceRevision } = input;
  return core.request({ kind: 'schemeGraph', nodeId, sourceRevision });
});

bridge('scheme-export', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, baseRevision } = input;
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    return projectError('INVALID_INPUT', 'Choose a saved Scheme revision.');
  }
  choosingDirectory = true;
  try {
    const pick = await dialog.showSaveDialog(window, {
      title: 'Export Scheme JSON', defaultPath: 'Scheme.forge-scheme.json',
      filters: [{ name: 'Scheme JSON', extensions: ['json'] }],
    });
    if (pick.canceled) return { ok: true, value: false };
    const saved = await core.request({ kind: 'schemeExport', nodeId, baseRevision, destination: pick.filePath });
    return saved.ok ? { ok: true, value: true } : saved;
  } finally {
    choosingDirectory = false;
  }
});

async function runAnalysis(input, kind, options = {}) {
  const current = currentAsset(input);
  if (!current.ok) return current;
  if (activeAnalysis) return projectError('PROJECT_BUSY', 'Wait for the current analysis to finish.');
  const { projectId, operationId, baseRevision, targetId } = input;
  const operation = { projectId, operationId, cancelRequested: false };
  activeAnalysis = operation;
  try {
    return await core.request({ kind, request: { operationId, baseRevision, targetId, ...options } });
  } finally {
    activeAnalysis = undefined;
  }
}

bridge('run-palette', input => runAnalysis(input, 'runPalette', { colors: input?.colors }));
bridge('run-metadata', input => runAnalysis(input, 'runMetadata'));
bridge('run-comparison', input => runAnalysis(input, 'runComparison', { left: input?.left, right: input?.right }));

bridge('editor-preview', async input => {
  const preview = await runAnalysis(input, 'editorPreview', { graph: input?.graph, selection: input?.selection });
  if (!preview.ok) return preview;
  const { width, height, image } = preview.value;
  return { ok: true, value: { width, height, src: assetPreviewForRenderer({ ok: true, value: image }).value.src } };
});

bridge('editor-export', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  if (activeAnalysis) return projectError('PROJECT_BUSY', 'Wait for the current analysis to finish.');
  const { name, format, repeatVersion } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 192 || !['png', 'jpeg'].includes(format)) {
    return projectError('INVALID_INPUT', 'Enter an output name and choose PNG or JPEG.');
  }
  choosingDirectory = true;
  let confirmed;
  try {
    ({ response: confirmed } = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Export Editor image',
      message: 'Create a new image in this project?',
      detail: name.trim() + '.' + format,
      buttons: ['Cancel', 'Export'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }));
  } finally {
    choosingDirectory = false;
  }
  if (confirmed !== 1) return { ok: true, value: null };
  return runAnalysis(input, 'editorExport', { name, format, repeatVersion });
});

bridge('cancel-analysis', async input => {
  const operation = activeAnalysis;
  if (!operation || operation.projectId !== input?.projectId || operation.operationId !== input?.operationId ||
      operation.cancelRequested) return { ok: true, value: false };
  operation.cancelRequested = true;
  try {
    await core.cancelAnalysis(operation.operationId);
    return { ok: true, value: true };
  } catch (error) {
    operation.cancelRequested = false;
    throw error;
  }
});

bridge('palette-status', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'paletteStatus', targetId: input.targetId });
});

bridge('palette-history', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'paletteHistory', targetId: input.targetId, before: input.before });
});

bridge('palette-files', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, resultId, offset, limit } = input;
  return core.request({ kind: 'paletteFiles', targetId, resultId, offset, limit });
});

bridge('metadata-status', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'metadataStatus', targetId: input.targetId });
});

bridge('metadata-history', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'metadataHistory', targetId: input.targetId, before: input.before });
});

bridge('metadata-files', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, resultId, offset, limit } = input;
  return core.request({ kind: 'metadataFiles', targetId, resultId, offset, limit });
});

bridge('metadata-location', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, resultId, versionId } = input;
  return core.request({ kind: 'metadataLocation', targetId, resultId, versionId });
});

bridge('comparison-choices', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, linkId, sourceRevision, offset, limit } = input;
  return core.request({ kind: 'comparisonChoices', targetId, linkId, sourceRevision, offset, limit });
});

bridge('comparison-status', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'comparisonStatus', targetId: input.targetId });
});

bridge('comparison-history', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'comparisonHistory', targetId: input.targetId, before: input.before });
});

bridge('comparison-lines', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, resultId, offset, limit } = input;
  return core.request({ kind: 'comparisonLines', targetId, resultId, offset, limit });
});

bridge('comparison-preview', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { targetId, resultId, side } = input;
  return assetPreviewForRenderer(await core.request({ kind: 'comparisonPreview', targetId, resultId, side }));
});

bridge('directory-change', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, baseRevision, change } = input;
  choosingDirectory = true;
  try {
    if (change?.kind === 'delete') {
      if (typeof change.name !== 'string' || !change.name || change.name.length > 240) {
        return projectError('INVALID_INPUT', 'Choose a project file or an empty folder.');
      }
      const confirmed = await confirmFileAction('Delete ' + change.name + '?',
        'This removes the selected file or empty folder. Space Undo does not restore files deleted in Directory.', 'Delete');
      if (!confirmed) return { ok: true, value: false };
    }
    const result = await core.request({ kind: 'directoryChange', nodeId, baseRevision, change });
    return result.ok ? { ok: true, value: true } : result;
  } finally {
    choosingDirectory = false;
  }
});

function editSummary(edit, currentVersion) {
  return edit ? { stale: edit.versionId !== currentVersion } : null;
}

function staleEdit() {
  return projectError('EDIT_COPY_STALE', 'The card has a newer version. Open the copy folder to recover the edited file.');
}

async function confirmFileAction(message, detail, action) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning', title: 'Forge', message, detail, buttons: ['Cancel', action], defaultId: 0, cancelId: 0, noLink: true,
  });
  return response === 1;
}

bridge('document-edit-state', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return { ok: true, value: editSummary(documentEdits.get(input), input.versionId) };
}, { needsCore: false });

bridge('open-edit-copy', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  let edit = documentEdits.get(input);
  if (edit && edit.versionId !== input.versionId) return staleEdit();
  const existing = !!edit;
  const { nodeId, versionId } = input;
  choosingDirectory = true;
  try {
    const details = await core.request({ kind: 'assetDetails', nodeId, versionId });
    if (!details.ok) return details;
    if (!documentEditorFormat(details.value.format)) return projectError('INVALID_INPUT', 'Edit copy is available for PDF and DOCX.');
    if (!edit) {
      const confirmed = await confirmFileAction('Open a writable copy?', 'Select an installed editor in Windows. Save changes to the copy and return to Forge to import them.', 'Choose editor');
      if (!confirmed) return { ok: true, value: null };
      const prepared = await documentEdits.create(input, details.value.format, destination =>
        core.request({ kind: 'exportAsset', nodeId, versionId, destination }));
      if (!prepared.ok) return prepared;
      edit = prepared.value;
    }
    const file = await documentEdits.source(edit);
    const chooser = fixtureMode && globalThis.forgeQualification?.chooseDocumentEditor;
    const selection = chooser ? await chooser(file) : await chooseDocumentEditor(coreExecutable, window, file);
    if (selection.outcome === 'chosen') return { ok: true, value: editSummary(edit, versionId) };
    if (!existing) await documentEdits.discard(edit);
    if (selection.outcome === 'canceled') return { ok: true, value: null };
    const failure = selection.windowsFailure;
    const detail = failure
      ? (failure.operation === 'initialize' ? 'Windows editor selection setup' : 'The Windows editor chooser') +
        ' returned ' + failure.hresult + '. '
      : '';
    const retry = existing
      ? 'Use Open copy folder to recover your working file.'
      : 'Try Edit copy again, or edit a downloaded copy and use Replace file.';
    return projectError('EDITOR_UNAVAILABLE', 'Windows could not open an editor. ' + detail + retry);
  } catch {
    return projectError('EDIT_COPY_IO_ERROR', 'Forge could not prepare or open the edit copy. Check its folder and try again.');
  } finally {
    choosingDirectory = false;
  }
});

bridge('import-edit-copy', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const edit = documentEdits.get(input);
  if (!edit) return projectError('EDIT_COPY_UNAVAILABLE', 'Open an edit copy before importing changes.');
  if (edit.versionId !== input.versionId) return staleEdit();
  choosingDirectory = true;
  try {
    const confirmed = await confirmFileAction('Import saved changes?', 'Save and close the copy in the editor first. Forge will validate it and create a new version on this card.', 'Import new version');
    if (!confirmed) return { ok: true, value: null };
    const source = await documentEdits.source(edit);
    return await core.request({ kind: 'importEditedDocument', request: {
      operationId: input.operationId, baseRevision: input.baseRevision, nodeId: edit.nodeId, versionId: edit.versionId, source,
    } });
  } catch {
    return projectError('EDIT_COPY_IO_ERROR', 'Forge could not read the edit copy. Save and close it in the editor and try again.');
  } finally {
    choosingDirectory = false;
  }
});

bridge('reveal-edit-copy', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const edit = documentEdits.get(input);
  if (!edit) return projectError('EDIT_COPY_UNAVAILABLE', 'The edit copy is unavailable.');
  try {
    const error = await shell.openPath(await documentEdits.folder(edit));
    if (!error) return { ok: true, value: null };
  } catch {
    // Report filesystem and shell failures consistently without disclosing the working path.
  }
  return projectError('EDIT_COPY_IO_ERROR', 'Windows could not open the copy folder.');
}, { needsCore: false });

bridge('discard-edit-copy', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const edit = documentEdits.get(input);
  if (!edit) return { ok: true, value: false };
  choosingDirectory = true;
  try {
    const confirmed = await confirmFileAction('Discard the edit copy?', 'This removes the working copy and its unimported changes. Project versions are preserved.', 'Discard copy');
    if (!confirmed) return { ok: true, value: false };
    await documentEdits.discard(edit);
    return { ok: true, value: true };
  } catch {
    return projectError('EDIT_COPY_IO_ERROR', 'Forge could not remove the copy. Close it in the editor and try again.');
  } finally {
    choosingDirectory = false;
  }
}, { needsCore: false });

bridge('preview-asset', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const result = await core.request({ kind: 'previewAsset', nodeId: input.nodeId, versionId: input.versionId });
  return assetPreviewForRenderer(result);
});

function assetPreviewForRenderer(result) {
  if (!result.ok || result.value.kind !== 'image') return result;
  const png = Buffer.from(result.value.png).toString('base64');
  return { ok: true, value: { kind: 'image', src: 'data:image/png;base64,' + png } };
}

bridge('open-asset', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, versionId } = input;
  choosingDirectory = true;
  try {
    const details = await core.request({ kind: 'assetDetails', nodeId, versionId });
    if (!details.ok) return details;
    const copy = await assetOpen.copy(details.value.format, destination => core.request({ kind: 'exportAsset', nodeId, versionId, destination }));
    if (!copy.ok) return copy;
    if (copy.value.mime) {
      const src = await assetOpen.presentImage(copy.value);
      return { ok: true, value: { kind: 'image', src } };
    }
    const opened = await shell.openPath(copy.value.file).then(error => !error, () => false);
    if (!opened) {
      await assetOpen.discard(copy.value.directory);
      return projectError('VIEWER_UNAVAILABLE', 'Windows could not open the file. Set a default app for this format or download the original.');
    }
    assetOpen.keepDocument(copy.value.directory);
    return { ok: true, value: { kind: 'external' } };
  } catch {
    return projectError('OPEN_IO_ERROR', 'Forge could not prepare the file for opening.');
  } finally {
    choosingDirectory = false;
  }
});

bridge('release-image', async src => {
  await assetOpen.releaseImage(src);
  return { ok: true, value: null };
}, { needsCore: false });

bridge('read-asset-text', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  return core.request({ kind: 'readAssetText', nodeId: input.nodeId, versionId: input.versionId });
});

bridge('edit-text-asset', input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, versionId, baseRevision, operationId, text } = input;
  if (typeof text !== 'string' || !text.isWellFormed()) {
    return projectError('INVALID_INPUT', 'Enter valid UTF-8 text.');
  }
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024) {
    return projectError('INVALID_INPUT', 'The text exceeds the 256 KiB editor limit.');
  }
  return core.request({ kind: 'editTextAsset', request: { nodeId, versionId, baseRevision, operationId, text } });
});

bridge('download-asset', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, versionId } = input;
  choosingDirectory = true;
  try {
    const details = await core.request({ kind: 'assetDetails', nodeId, versionId });
    if (!details.ok) return details;
    const { name, format } = details.value;
    const selection = await dialog.showSaveDialog(window, {
      title: 'Download original file',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [assetFilter(format)],
    });
    if (selection.canceled) return { ok: true, value: false };
    const result = await core.request({ kind: 'exportAsset', nodeId, versionId, destination: selection.filePath });
    return result.ok ? { ok: true, value: true } : result;
  } finally {
    choosingDirectory = false;
  }
});

bridge('replace-asset', async input => {
  const current = currentAsset(input);
  if (!current.ok) return current;
  const { nodeId, versionId, baseRevision, operationId } = input;
  choosingDirectory = true;
  try {
    const details = await core.request({ kind: 'assetDetails', nodeId, versionId });
    if (!details.ok) return details;
    const selected = await dialog.showOpenDialog(window, {
      title: 'Replace file', properties: ['openFile'], filters: [assetFilter(details.value.format)],
    });
    if (selected.canceled) return { ok: true, value: null };
    if (!validImportPaths(selected.filePaths) || selected.filePaths.length !== 1) {
      return projectError('INVALID_INPUT', 'Choose one local file.');
    }
    const replaced = await core.request({ kind: 'replaceAsset', request: { nodeId, versionId, baseRevision, operationId, source: selected.filePaths[0] } });
    if (replaced.ok) await assetOpen.invalidateVideos(nodeId);
    return replaced;
  } finally {
    choosingDirectory = false;
  }
});

const siteIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function closeActiveSite() {
  const binding = activeSite;
  activeSite = undefined;
  binding?.browser?.close();
}

bridge('site-attach', async input => {
  if (choosingDirectory || !openedProjectId || input?.projectId !== openedProjectId) {
    return projectError('PROJECT_CHANGED', 'Open the project before browsing a Site.');
  }
  if (typeof input.lease !== 'string' || !siteIdPattern.test(input.lease) ||
      typeof input.nodeId !== 'string' || !siteIdPattern.test(input.nodeId)) {
    return projectError('INVALID_INPUT', 'Choose a Site card from Space.');
  }
  closeActiveSite();
  const binding = { lease: input.lease, nodeId: input.nodeId, projectId: openedProjectId };
  activeSite = binding;
  try {
    const reply = await core.request({ kind: 'view' });
    if (!reply.ok) return reply;
    if (activeSite !== binding || openedProjectId !== binding.projectId || choosingDirectory) {
      return projectError('PROJECT_CHANGED', 'This Site is no longer open.');
    }
    const content = reply.value.space.nodes.find(node => node.id === binding.nodeId)?.content;
    if (reply.value.space.projectId !== binding.projectId ||
        content?.kind !== 'portal' || content.typeId !== 'forge.site' || content.schemaVersion !== 1) {
      return projectError('INVALID_INPUT', 'Choose a Site card from Space.');
    }
    binding.browser = new SiteBrowser(window, {
      projectId: binding.projectId, plainId: content.plainId,
      profileDirectory: app.getPath('userData'),
      configureTestCertificate: fixtureMode ? useFixtureCertificate : undefined,
      update: state => {
        if (activeSite === binding && !window.isDestroyed()) window.webContents.send('forge:site:state', { lease: binding.lease, state });
      },
    });
    if (binding.bounds) binding.browser.setBounds(binding.bounds);
    const { reference } = JSON.parse(content.payload);
    if (reference) binding.browser.navigate(reference.url);
    return { ok: true, value: true };
  } catch {
    if (activeSite === binding) closeActiveSite();
    return projectError('SITE_UNAVAILABLE', 'The Site browser could not open. Return to Space and try again.');
  } finally {
    if (activeSite === binding && !binding.browser) closeActiveSite();
  }
});

bridge('site-detach', lease => {
  if (activeSite && activeSite.lease === lease) closeActiveSite();
  return { ok: true, value: true };
}, { needsCore: false });

bridge('site-bounds', input => {
  if (!activeSite || input?.lease !== activeSite.lease) return { ok: true, value: false };
  const box = input.bounds;
  if (box !== null && (!box ||
      ![box.x, box.y, box.width, box.height].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 16384))) {
    return projectError('INVALID_INPUT', 'Invalid Site view bounds.');
  }
  const zoom = window.webContents.getZoomFactor();
  const bounds = box && {
    x: Math.round(box.x * zoom), y: Math.round(box.y * zoom),
    width: Math.round(box.width * zoom), height: Math.round(box.height * zoom),
  };
  activeSite.bounds = bounds;
  activeSite.browser?.setBounds(bounds);
  return { ok: true, value: true };
}, { needsCore: false });

bridge('site-command', async input => {
  const browser = activeSite?.browser;
  if (!browser || input?.lease !== activeSite.lease || activeSite.projectId !== openedProjectId || choosingDirectory) {
    return projectError('SITE_UNAVAILABLE', 'Open the active Site before browsing.');
  }
  if (input.action === 'reference') {
    const reference = browser.reference();
    return reference ? { ok: true, value: reference } : projectError('SITE_NOT_READY', 'Wait for an HTTPS page to load.');
  }
  if (input.action === 'go') browser.navigate(input.address);
  else if (['back', 'forward', 'reload'].includes(input.action)) browser.history(input.action);
  else if (input.action === 'login') return { ok: true, value: browser.startLogin() };
  else if (input.action === 'discard-login') browser.discardLogin();
  else if (input.action === 'save-download') return { ok: true, value: await browser.saveDownload() };
  else if (input.action === 'cancel-download') browser.cancelDownload();
  else if (input.action === 'dismiss-download') browser.dismissDownload();
  else if (input.action === 'clear') return { ok: true, value: await browser.clear() };
  else return projectError('INVALID_INPUT', 'Unknown Site command.');
  return { ok: true, value: true };
}, { needsCore: false });

function closeSite() {
  if (!site) return;
  window?.contentView.removeChildView(site);
  site.webContents.close();
  site = undefined;
}

function useFixtureCertificate(profile) {
  profile.setCertificateVerifyProc((request, callback) => {
    try {
      const expected = process.env.FORGE_FIXTURE_CERTIFICATE_FINGERPRINT;
      const fingerprint = new X509Certificate(request.certificate.data).fingerprint256;
      if (expected && request.hostname === '127.0.0.1' && fingerprint === expected) {
        callback(0);
        return;
      }
    } catch {
      // Fall back to Chromium TLS verification.
    }
    callback(-3);
  });
}

async function openQualificationSite(url, siteId) {
  if (!fixtureMode || !window || !/^[a-z0-9-]{1,48}$/.test(siteId)) throw new Error('Invalid qualification input');
  const fixtureOrigin = process.env.FORGE_FIXTURE_ORIGIN;
  const target = allowedSiteUrl(url);
  if (!target || new URL(target).origin !== fixtureOrigin) throw new Error('Navigation denied');
  closeSite();
  lastSitePopup = undefined;
  lastSiteDownload = undefined;
  const partition = 'persist:qualification-' + siteId;
  const profile = session.fromPartition(partition);
  denySitePermissions(profile);
  useFixtureCertificate(profile);
  site = new WebContentsView(siteViewOptions(partition));
  const { webContents } = site;
  const constrainNavigation = (event, targetUrl) => {
    const destination = allowedSiteUrl(typeof targetUrl === 'string' ? targetUrl : targetUrl.url);
    if (!destination || new URL(destination).origin !== fixtureOrigin) event.preventDefault();
  };
  const captureDownload = (_event, item, originContents) => {
    if (originContents.id !== webContents.id) return;
    lastSiteDownload = item.getFilename();
    item.cancel();
  };
  webContents.on('will-navigate', constrainNavigation);
  webContents.on('will-redirect', constrainNavigation);
  webContents.setWindowOpenHandler(({ url: popup }) => {
    lastSitePopup = allowedSiteUrl(popup) ?? undefined;
    return { action: 'deny' };
  });
  profile.on('will-download', captureDownload);
  webContents.once('destroyed', () => profile.off('will-download', captureDownload));
  window.contentView.addChildView(site);
  const { width, height } = window.getContentBounds();
  site.setBounds({ x: 40, y: 90, width: width - 80, height: height - 130 });
  await webContents.loadURL(target);
  return webContents.id;
}

if (fixtureMode) {
  globalThis.forgeQualification = {
    openSite: openQualificationSite,
    closeSite,
    async clearSite(siteId) {
      if (!/^[a-z0-9-]{1,48}$/.test(siteId)) throw new Error('Invalid qualification input');
      const profile = session.fromPartition('persist:qualification-' + siteId);
      if (site?.webContents.session === profile) closeSite();
      await clearSiteSession(profile);
    },
    observations: () => ({ popup: lastSitePopup, download: lastSiteDownload }),
  };
}

async function openWindow() {
  window = new BrowserWindow({
    title: 'Forge',
    width: 1440,
    height: 900,
    minWidth: 640,
    minHeight: 520,
    backgroundColor: '#fafaf8',
    show: !fixtureMode && !startupChallenge,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: !fixtureMode && !startupChallenge,
      offscreen: offscreenBenchmark,
      preload: path.join(root, 'apps', 'desktop', 'preload.cjs'),
      additionalArguments: [
        '--forge-build-version=' + app.getVersion(),
        '--forge-build-channel=' + (app.isPackaged ? 'Stable' : 'Development'),
      ],
    },
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (offscreenBenchmark) window.webContents.setFrameRate(60);
  window.on('close', () => { closeActiveSite(); closeSite(); });
  const query = fixtureMode && process.env.FORGE_CANVAS_FIXTURE ? { fixture: process.env.FORGE_CANVAS_FIXTURE } : undefined;
  await window.loadFile(entry, { query });
}

app.whenReady().then(async () => {
  const profile = session.defaultSession;
  profile.webRequest.onBeforeRequest({ urls: [imageScheme, audioScheme, videoScheme].map(scheme => scheme + '://*/*') }, (details, callback) => {
    const expected = details.url.startsWith(imageScheme + ':') ? 'image' : 'media';
    callback({ cancel: details.webContentsId !== window?.webContents?.id || details.resourceType !== expected || !primaryFrame(details.frame) });
  });
  profile.protocol.handle(imageScheme, request => assetOpen.response(request));
  profile.protocol.handle(audioScheme, request => assetOpen.audioResponse(request));
  profile.protocol.handle(videoScheme, request => assetOpen.videoResponse(request));
  if (startupChallenge) {
    await openWindow();
    await completeStartup(startupChallenge, window, coreExecutable);
    stopStartupWatch();
    startupBarrier.resolve();
    window.webContents.send('forge:updates:restarted');
    window.show();
  }
  void assetOpen.sweep().catch(() => {});
  void sweepSiteDownloads(app.getPath('userData')).catch(() => {});
  await documentEdits.restore();
  if (!startupChallenge) await openWindow();
  void diagnostics.start();
}).catch(() => {
  console.error('Forge startup failed.');
  app.exit(1);
});
app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (activeImport && !activeImport.committing) void core?.cancelImport(activeImport.operationId).catch(() => {});
  if (activeAnalysis) void core?.cancelAnalysis(activeAnalysis.operationId).catch(() => {});
  core?.close();
  intelligent.clear();
  transcription.clear();
  void Promise.allSettled([assetOpen.clearPreviews(), diagnostics.stop()]).then(() => app.quit());
});

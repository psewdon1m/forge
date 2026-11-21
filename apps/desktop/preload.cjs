const { contextBridge, ipcRenderer, webUtils } = require('electron');

function onFileDrop(listener) {
  const dragover = event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  };
  const drop = async event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const zone = event.target.closest('[data-forge-file-drop]');
    if (!zone) return;
    const galleryId = zone.getAttribute('data-forge-file-drop') || undefined;
    const { clientX, clientY } = event;
    const files = event.dataTransfer.files;
    try {
      if (files.length === 0 || files.length > 50) throw new Error('Invalid file count');
      const paths = Array.from(files, file => webUtils.getPathForFile(file));
      listener({ clientX, clientY, galleryId, reply: await ipcRenderer.invoke('forge:project:register-drop', paths) });
    } catch {
      listener({ clientX, clientY, galleryId, reply: { ok: false, error: { code: 'INVALID_INPUT', message: 'Drop between 1 and 50 local files.' } } });
    }
  };
  globalThis.addEventListener('dragover', dragover);
  globalThis.addEventListener('drop', drop);
  return () => {
    globalThis.removeEventListener('dragover', dragover);
    globalThis.removeEventListener('drop', drop);
  };
}

function buildValue(name) {
  const prefix = '--forge-build-' + name + '=';
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

contextBridge.exposeInMainWorld('forge', {
  build: { version: buildValue('version'), channel: buildValue('channel') },
  updates: {
    status: () => ipcRenderer.invoke('forge:project:update-status'),
    check: () => ipcRenderer.invoke('forge:project:check-updates'),
    stage: selection => ipcRenderer.invoke('forge:project:stage-update', selection),
    restart: id => ipcRenderer.invoke('forge:project:restart-update', id),
    rollback: id => ipcRenderer.invoke('forge:project:rollback-update', id),
    onRestarted: listener => {
      const handler = () => listener();
      ipcRenderer.on('forge:updates:restarted', handler);
      return () => ipcRenderer.removeListener('forge:updates:restarted', handler);
    },
  },
  project: {
    create: title => ipcRenderer.invoke('forge:project:create', title),
    open: () => ipcRenderer.invoke('forge:project:open'),
    recent: () => ipcRenderer.invoke('forge:project:recent'),
    openRecent: id => ipcRenderer.invoke('forge:project:open-recent', id),
    close: () => ipcRenderer.invoke('forge:project:close'),
    archive: id => ipcRenderer.invoke('forge:project:archive', id),
    view: () => ipcRenderer.invoke('forge:project:view'),
    exportBackup: input => ipcRenderer.invoke('forge:project:backup-export', input),
    inspectBackup: () => ipcRenderer.invoke('forge:project:backup-inspect'),
    restoreBackup: token => ipcRenderer.invoke('forge:project:backup-restore', token),
    readSettings: () => ipcRenderer.invoke('forge:project:settings-read'),
    saveSettings: input => ipcRenderer.invoke('forge:project:settings-save', input),
    exportSettingsBackup: () => ipcRenderer.invoke('forge:project:settings-backup-export'),
    inspectSettingsBackup: () => ipcRenderer.invoke('forge:project:settings-backup-inspect'),
    restoreSettingsBackup: token => ipcRenderer.invoke('forge:project:settings-backup-restore', token),
    logsPage: before => ipcRenderer.invoke('forge:project:logs-page', before),
    exportLogs: () => ipcRenderer.invoke('forge:project:logs-export'),
    onLogsHealth: listener => {
      const handler = (_event, health) => listener(health);
      ipcRenderer.on('forge:diagnostics:health', handler);
      return () => ipcRenderer.removeListener('forge:diagnostics:health', handler);
    },
    apply: request => ipcRenderer.invoke('forge:project:apply', request),
    saveViewport: input => ipcRenderer.invoke('forge:project:viewport', input),
    history: before => ipcRenderer.invoke('forge:project:history', before),
    importAssets: input => ipcRenderer.invoke('forge:project:import-assets', input),
    galleryPage: input => ipcRenderer.invoke('forge:project:gallery-page', input),
    galleryPreview: input => ipcRenderer.invoke('forge:project:gallery-preview', input),
    videoOpen: input => ipcRenderer.invoke('forge:project:video-open', input),
    videoRelease: src => ipcRenderer.invoke('forge:project:video-release', src),
    linkedAssets: input => ipcRenderer.invoke('forge:project:linked-assets', input),
    linkedText: input => ipcRenderer.invoke('forge:project:linked-text', input),
    researchStatus: input => ipcRenderer.invoke('forge:project:research-status', input),
    modelReview: input => ipcRenderer.invoke('forge:project:model-review', input),
    modelSend: input => ipcRenderer.invoke('forge:project:model-send', input),
    modelCancel: input => ipcRenderer.invoke('forge:project:model-cancel', input),
    modelSave: input => ipcRenderer.invoke('forge:project:model-save', input),
    transcriptionReview: input => ipcRenderer.invoke('forge:project:transcription-review', input),
    transcriptionStart: input => ipcRenderer.invoke('forge:project:transcription-start', input),
    transcriptionCancel: input => ipcRenderer.invoke('forge:project:transcription-cancel', input),
    transcriptionSave: input => ipcRenderer.invoke('forge:project:transcription-save', input),
    researchPreview: input => ipcRenderer.invoke('forge:project:research-preview', input),
    researchAudio: input => ipcRenderer.invoke('forge:project:research-audio', input),
    releaseResearchAudio: src => ipcRenderer.invoke('forge:project:release-research-audio', src),
    checklistCompletions: input => ipcRenderer.invoke('forge:project:checklist-completions', input),
    datasetRead: input => ipcRenderer.invoke('forge:project:dataset-read', input),
    datasetPreview: input => ipcRenderer.invoke('forge:project:dataset-preview', input),
    datasetPage: input => ipcRenderer.invoke('forge:project:dataset-page', input),
    datasetExport: input => ipcRenderer.invoke('forge:project:dataset-export', input),
    schemeRead: input => ipcRenderer.invoke('forge:project:scheme-read', input),
    schemeGraph: input => ipcRenderer.invoke('forge:project:scheme-graph', input),
    schemeExport: input => ipcRenderer.invoke('forge:project:scheme-export', input),
    siteAttach: input => ipcRenderer.invoke('forge:project:site-attach', input),
    siteDetach: lease => ipcRenderer.invoke('forge:project:site-detach', lease),
    siteBounds: input => ipcRenderer.invoke('forge:project:site-bounds', input),
    siteCommand: input => ipcRenderer.invoke('forge:project:site-command', input),
    onSiteState: listener => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on('forge:site:state', handler);
      return () => ipcRenderer.removeListener('forge:site:state', handler);
    },
    runPalette: input => ipcRenderer.invoke('forge:project:run-palette', input),
    cancelAnalysis: input => ipcRenderer.invoke('forge:project:cancel-analysis', input),
    paletteStatus: input => ipcRenderer.invoke('forge:project:palette-status', input),
    paletteHistory: input => ipcRenderer.invoke('forge:project:palette-history', input),
    paletteFiles: input => ipcRenderer.invoke('forge:project:palette-files', input),
    runMetadata: input => ipcRenderer.invoke('forge:project:run-metadata', input),
    metadataStatus: input => ipcRenderer.invoke('forge:project:metadata-status', input),
    metadataHistory: input => ipcRenderer.invoke('forge:project:metadata-history', input),
    metadataFiles: input => ipcRenderer.invoke('forge:project:metadata-files', input),
    metadataLocation: input => ipcRenderer.invoke('forge:project:metadata-location', input),
    comparisonChoices: input => ipcRenderer.invoke('forge:project:comparison-choices', input),
    runComparison: input => ipcRenderer.invoke('forge:project:run-comparison', input),
    editorPreview: input => ipcRenderer.invoke('forge:project:editor-preview', input),
    editorExport: input => ipcRenderer.invoke('forge:project:editor-export', input),
    comparisonStatus: input => ipcRenderer.invoke('forge:project:comparison-status', input),
    comparisonHistory: input => ipcRenderer.invoke('forge:project:comparison-history', input),
    comparisonLines: input => ipcRenderer.invoke('forge:project:comparison-lines', input),
    comparisonPreview: input => ipcRenderer.invoke('forge:project:comparison-preview', input),
    cancelImport: input => ipcRenderer.invoke('forge:project:cancel-import', input),
    onImportProgress: listener => {
      const handler = (_event, progress) => listener(progress);
      ipcRenderer.on('forge:project:import-progress', handler);
      return () => ipcRenderer.removeListener('forge:project:import-progress', handler);
    },
    directoryList: input => ipcRenderer.invoke('forge:project:directory-list', input),
    gitBind: input => ipcRenderer.invoke('forge:project:git-bind', input),
    gitUnbind: input => ipcRenderer.invoke('forge:project:git-unbind', input),
    gitRead: input => ipcRenderer.invoke('forge:project:git-read', input),
    gitDiff: input => ipcRenderer.invoke('forge:project:git-diff', input),
    gitMutate: input => ipcRenderer.invoke('forge:project:git-mutate', input),
    changeDirectory: input => ipcRenderer.invoke('forge:project:directory-change', input),
    previewAsset: input => ipcRenderer.invoke('forge:project:preview-asset', input),
    openAsset: input => ipcRenderer.invoke('forge:project:open-asset', input),
    releaseImage: src => ipcRenderer.invoke('forge:project:release-image', src),
    documentEditState: input => ipcRenderer.invoke('forge:project:document-edit-state', input),
    openEditCopy: input => ipcRenderer.invoke('forge:project:open-edit-copy', input),
    importEditCopy: input => ipcRenderer.invoke('forge:project:import-edit-copy', input),
    revealEditCopy: input => ipcRenderer.invoke('forge:project:reveal-edit-copy', input),
    discardEditCopy: input => ipcRenderer.invoke('forge:project:discard-edit-copy', input),
    readAssetText: input => ipcRenderer.invoke('forge:project:read-asset-text', input),
    editTextAsset: input => ipcRenderer.invoke('forge:project:edit-text-asset', input),
    downloadAsset: input => ipcRenderer.invoke('forge:project:download-asset', input),
    replaceAsset: input => ipcRenderer.invoke('forge:project:replace-asset', input),
    onFileDrop,
  },
});

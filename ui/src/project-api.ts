export type ProjectPosition = { x: number; y: number };
export type ProjectViewport = ProjectPosition & { zoom: number };
export type ChecklistItem = {
  id: string; label: string; done: boolean; groupId?: string; completion?: { occurredAt: string; revision: number };
};
export type ChecklistGroup = { id: string; label: string };
export type ChecklistData = { items: ChecklistItem[]; groups?: ChecklistGroup[] };
export type ChecklistRecordPage = { sourceRevision: string; total: number; nextOffset: number | null; groups: ChecklistGroup[]; rows: ChecklistItem[] };
export type DatasetDelimiter = 'comma' | 'tab';
export type DatasetKind = 'string' | 'number' | 'boolean' | 'date';
export type DatasetOptions = { delimiter: DatasetDelimiter; header: boolean; types: DatasetKind[] };
export type DatasetColumn = { name: string; kind: DatasetKind };
export type DatasetIssue = { line: number; column: number | null; message: string };
export type DatasetPreview = {
  columns: DatasetColumn[]; rows: { line: number; cells: string[] }[]; total: number; issues: DatasetIssue[]; issueCount: number;
};
export type DatasetFile = { name: string; delimiter: DatasetDelimiter; text: string };
export type DatasetQuery = { offset: number; limit: number; sourceRevision?: string; filter?: string; sort?: { column: number; descending: boolean } };
export type DatasetPage = {
  columns: DatasetColumn[]; rows: { id: string; ordinal: number; cells: { raw: string; value: string | number | boolean | null }[] }[];
  sourceRevision: string; total: number; nextOffset: number | null;
};
export type DatasetChange =
  | { kind: 'importDataset'; text: string; options: DatasetOptions }
  | { kind: 'editDatasetCell'; rowId: string; column: number; raw: string };
export type SchemeKind = 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'line';
export type SchemeElement = {
  id: string; kind: SchemeKind; position: ProjectPosition; width: number; height: number; text: string; angle?: number;
};
export type SchemeConnection = { id: string; from: string; to: string; route: 'straight' | 'orthogonal'; text: string };
export type SchemeGraph = { elements: SchemeElement[]; lines: SchemeConnection[] };
export type SchemeDocument = SchemeGraph & { viewport: ProjectViewport };
export type VideoFormat = 'webm' | 'mp4';
export type AssetFormat = 'png' | 'jpeg' | 'webp' | 'txt' | 'md' | 'pdf' | 'docx' | 'wav' | VideoFormat;
export type AssetRef = { assetId: string; versionId: string; name: string; format: AssetFormat; bytes: number; sha256: string };
export type GalleryItem = Pick<AssetRef, 'assetId' | 'versionId'>;
export type AssetPage = { sourceRevision: string; total: number; nextOffset: number | null; items: AssetRef[] };
export type DirectoryFile = Omit<AssetRef, 'format' | 'sha256'> & {
  relativePath: string[]; fingerprint: string; format: AssetFormat | null; sha256: string | null;
};
export type SourceFile = AssetRef | DirectoryFile;
export type LinkedFilePage = Omit<AssetPage, 'items'> & { items: SourceFile[]; unavailableCount?: number };
export type DataType = 'FileCollection' | 'ImageCollection' | 'TextContent' | 'ColorPalette' | 'MetadataCollection' | 'ComparisonResult' | 'ChecklistCompletionRecords' | 'TabularData' | 'GraphData' | 'ResearchSources';
export type LinkPort = { nodeId: string; portId: string };
export type DataLink = { id: string; source: LinkPort; target: LinkPort; dataType: DataType; contractVersion: number; access: 'readOnly' };
export type PaletteColors = 4 | 8 | 16;
export type Swatch = { hex: string; basisPoints: number };
export type AnalysisTarget = { projectId: string; targetId: string };
export type AnalysisRun = AnalysisTarget & { operationId: string; baseRevision: number };
export type EditorSelection = { linkId: string; sourceRevision: string; versionId: string };
export type EditorOperation =
  | { kind: 'crop'; x: number; y: number; width: number; height: number }
  | { kind: 'resize'; width: number; height: number }
  | { kind: 'exposure'; quarterStops: number }
  | { kind: 'color'; red: number; green: number; blue: number };
export type EditorStep = { id: string; input: string | null; operation: EditorOperation };
export type EditorGraph = { nodes: EditorStep[]; output: string | null };
export type EditorRecipe = { graph: EditorGraph; source: AssetRef };
export type EditorFormat = 'png' | 'jpeg';
export type EditorDocument = {
  recipe: EditorRecipe | null;
  exports: { asset: AssetRef & { format: EditorFormat }; recipe: EditorRecipe }[];
};
export type EditorPreview = { width: number; height: number; src: string };
export type EditorExportInput = AnalysisRun & { name: string; format: EditorFormat; repeatVersion?: string };
export type AnalysisProvenance = {
  id: string; projectRevision: number; calculatedAt: string; algorithm: string; resultDigest: string;
  source: { linkId: string; nodeId: string; portId: string; revision: string; contractVersion: number };
};
export type PaletteSummary = AnalysisProvenance & {
  colors: PaletteColors; aggregate: Swatch[]; itemCount: number; transparentCount: number;
  skippedVideos?: number;
};
export type AnalysisStatus<T> = {
  state: 'notCalculated' | 'current' | 'stale' | 'sourceUnavailable';
  message: string | null; checkedAt: string; latest: T | null;
};
export type AnalysisHistoryItem<T> = { cursor: number; summary: T };
export type MetadataSummary = AnalysisProvenance & { itemCount: number; unavailableCount?: number };
export type ImageMetadata = {
  width: number; height: number; exif: 'absent' | 'available' | 'unreadable';
  fields: { label: string; value: string }[]; locationAvailable: boolean;
};
export type MetadataFile = { asset: SourceFile; image: ImageMetadata | null; issue?: string };
export type MetadataPage = { total: number; nextOffset: number | null; files: MetadataFile[] };
export type ExifLocation = { latitude: number; longitude: number };
export type ComparisonChoice = { name: string; asset: SourceFile | null };
export type PixelComparison = { state: 'compared'; width: number; height: number; changedPixels: number }
  | { state: 'dimensionsDiffer' | 'pixelLimit' };
export type ComparisonSelection = { linkId: string; sourceRevision: string; versionId: string | null };
export type ComparisonChoices = { sourceRevision: string; total: number; nextOffset: number | null; items: ComparisonChoice[]; unavailableCount?: number };
export type ComparisonSummary = AnalysisProvenance & {
  pair: [{ source: AnalysisProvenance['source']; choice: ComparisonChoice }, { source: AnalysisProvenance['source']; choice: ComparisonChoice }];
  mode: 'text' | 'images'; rows: number; added: number; removed: number; alignmentLimited: boolean;
  pixelComparison?: PixelComparison;
};
export type ComparisonLines = {
  total: number; nextOffset: number | null;
  lines: { kind: 'context' | 'added' | 'removed'; leftLine: number | null; rightLine: number | null; text: string; terminated: boolean }[];
};
export type PalettePage = { total: number; nextOffset: number | null; files: { asset: AssetRef; swatches: Swatch[] }[] };
export type AssetSelection = { projectId: string; nodeId: string; versionId: string };
export type VideoSelection = AssetSelection & { format: VideoFormat; sourceRevision?: string };
export type DocumentEditState = { stale: boolean };
export type DirectoryEntry = { name: string; kind: 'file' | 'folder' | 'unavailable'; bytes: number | null; version: string | null };
export type DirectoryListing = { folderVersion: string; entries: DirectoryEntry[] };
export type GitChange = 'added' | 'modified' | 'deleted' | 'typeChanged';
export type GitSide = 'staged' | 'unstaged';
export type GitSnapshot = {
  repositoryName: string; branch: string | null; head: string | null;
  branches: { name: string; commit: string }[];
  history: { id: string; subject: string; author: string; timeSeconds: number }[];
  historyHasMore: boolean;
  entries: { path: string; staged: GitChange | null; unstaged: GitChange | null; conflicted: boolean }[];
  conflicted: boolean; operationInProgress: boolean; revision: string;
};
export type GitCard = { projectId: string; nodeId: string };
export type GitAction =
  | { kind: 'stage' | 'unstage'; path: string }
  | { kind: 'commit'; authorName: string; authorEmail: string; message: string }
  | { kind: 'switchBranch'; branch: string };
export type GitPatch = { text: string; truncated: boolean };
export type DirectoryChange =
  | { kind: 'createFolder'; parent: string[]; folderVersion: string; name: string }
  | ({ parent: string[]; name: string; version: string } & (
      { kind: 'rename'; newName: string }
      | { kind: 'move'; destination: string[]; destinationVersion: string }
      | { kind: 'delete' }
    ));
export type AssetPreview = { kind: 'text'; text: string; truncated: boolean } | { kind: 'image'; src: string } | { kind: 'document' };
export type ImportResult = {
  revision: number;
  items: { name: string; asset: AssetRef | null; nodeId: string | null; errorCode: string | null; message: string | null }[];
};
export type ImportProgress = { operationId: string; totalFiles: number } & (
  { phase: 'copying'; fileIndex: number; bytes: number; fileBytes: number }
  | { phase: 'committing' }
);
export type ProjectContent =
  | { kind: 'note'; text: string }
  | { kind: 'asset'; asset: AssetRef }
  | { kind: 'portal'; plainId: string; typeId: string; schemaVersion: number; payload: string };
export type ProjectNode = { id: string; label: string; position: ProjectPosition; content: ProjectContent };
export type ProjectGroup = { id: string; members: string[] };
export type ProjectView = {
  space: { projectId: string; title: string; nodes: ProjectNode[]; groups?: ProjectGroup[]; links?: DataLink[] };
  revision: number;
  viewport: ProjectViewport;
  canUndo: boolean;
  canRedo: boolean;
};
export type ProjectChange =
  | { kind: 'add'; node: ProjectNode }
  | { kind: 'move'; id: string; position: ProjectPosition }
  | { kind: 'moveSelection'; placements: { id: string; position: ProjectPosition }[] }
  | { kind: 'renameProject'; title: string }
  | { kind: 'editNote'; id: string; text: string }
  | ({ kind: 'editChecklist'; id: string } & ChecklistData)
  | ({ id: string } & DatasetChange)
  | { kind: 'editScheme'; id: string; document: SchemeDocument }
  | { kind: 'editSite'; id: string; site: SiteData }
  | { kind: 'editResearch'; id: string; action: ResearchAction }
  | { kind: 'editEditor'; id: string; graph: EditorGraph; selection?: EditorSelection }
  | { kind: 'editGallery'; id: string; items: GalleryItem[] }
  | { kind: 'connect'; id: string; source: LinkPort; target: LinkPort }
  | { kind: 'disconnect'; id: string }
  | { kind: 'archiveNode'; id: string }
  | { kind: 'archiveSelection'; ids: string[] }
  | { kind: 'groupSelection'; ids: string[] }
  | { kind: 'ungroup'; id: string }
  | { kind: 'paste'; nodes: ProjectNode[]; groups: ProjectGroup[]; links?: DataLink[] }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'restoreRevision'; revision: number };
type ProjectError = { code: string; message: string; currentRevision?: number; correlationId?: string };
export type ProjectRevision = { revision: number; actor: string; reason: string; occurredAt: string; digest: string };
export type RecentProject = { id: string; title: string; openedAt: string };
export type Reply<T> = { ok: true; value: T; warning?: string } | { ok: false; error: ProjectError };
export type FileDrop = { clientX: number; clientY: number; galleryId?: string; reply: Reply<string> };
export type BackupInfo = {
  title: string; revision: number; createdAt: string; sourceVersion: string;
  archiveBytes: number; files: number; revisions: number; analyses: number;
};
export type SettingsState = { revision: number; preferences: { snapToGrid: boolean } };
export type UpdateCandidate = { version: string; notes: string; packageBytes: number; packageSha256: string; canStage: boolean };
export type UpdateSelection = Pick<UpdateCandidate, 'version' | 'packageSha256'>;
export type UpdateJob = {
  id: string; sourceVersion: string; targetVersion: string; message: string | null; recoveryMessage: string | null; canRollBack: boolean;
  phase: 'preparing' | 'backupSaved' | 'downloading' | 'verifying' | 'staged' | 'failed' | 'interrupted' |
    'starting' | 'healthy' | 'rollingBack' | 'rolledBack' | 'manualRollingBack' | 'manualRolledBack' | 'recoveryRequired';
};
export type UpdateStatus = { installedVersion: string; lastJob?: UpdateJob | null } & (
  | { state: 'ready' | 'upToDate' | 'offline' }
  | { state: 'unavailable'; message: string }
  | { state: 'incompatible'; version: string }
  | { state: 'available'; candidate: UpdateCandidate }
  | { state: 'error'; code: string; message: string; correlationId?: string }
);
export type SettingsBackupInfo = {
  name: string; archiveBytes: number; createdAt: string; sourceVersion: string; schemaVersion: number; snapToGrid: boolean;
};
export type LogsCursor = { occurredAt: number; sequence: number };
export type LogsRow = {
  id: string; occurredAt: number; outcome: 'success' | 'canceled' | 'error' | 'denied' | 'warning';
  summary: string; actor: string; target: string; targetId: string | null; correlationId: string;
  error: { code: string } | null;
};
export type LogsHealth = { recordingIssue: boolean; spaceLow: boolean };
export type SitePage = { url: string; title: string };
export type SiteReference = SitePage & { quote: string };
export type SiteData = { reference: SiteReference | null };
export type TranscriptSegment = { startMs: number; endMs: number; text: string };
export type TranscriptionLanguage = 'auto' | 'en' | 'ru';
export type TranscriptOrigin = { provider: 'whisper.cpp'; sourceRevision: string; requestedLanguage: TranscriptionLanguage;
  detectedLanguage: string; completedAt: number; responseSha256: string };
export type AudioMaterial = { kind: 'audio'; asset: AssetRef; durationMs: number; segments: TranscriptSegment[]; transcriptOrigin?: TranscriptOrigin };
export type TranscriptionReview = { id: string; provider: 'whisper.cpp'; endpoint: string; sourceId: string; revision: string;
  asset: AssetRef; durationMs: number; language: TranscriptionLanguage };
export type TranscriptionResult = { id: string; sourceId: string; segments: TranscriptSegment[]; origin: TranscriptOrigin };
export type ResearchMaterial = { kind: 'text'; text: string } | { kind: 'site'; reference: SiteReference } |
  { kind: 'file'; asset: AssetRef; text: string | null } |
  { kind: 'pdf'; asset: AssetRef; text: string; extraction: 'textLayerV1' | 'manual' } | AudioMaterial;
export type ResearchVersion = { revision: string; upstreamRevision: string | null; title: string; material: ResearchMaterial };
export type ResearchSource = {
  id: string; activeRevision: string; versions: ResearchVersion[];
  projectOnly?: boolean;
  origin: { kind: 'manual' } | { kind: 'linked'; linkId: string; nodeId: string; assetId: string | null };
};
export type ResearchCitation = { id: string; sourceId: string; revision: string; start: number; end: number };
export type ResearchDocument = {
  sources: ResearchSource[]; citations: ResearchCitation[];
  conclusions: { id: string; text: string; citationIds: string[]; contextRevision: string }[];
};
export type ResearchStatus = { contextRevision: string; sources: { id: string; state: 'current' | 'changed' | 'unavailable' }[] };
type ManualPdfText = { versionId: string; text: string };
export type ResearchAction =
  | { kind: 'capture'; linkId: string; assetId: string | null; pdfText?: ManualPdfText }
  | { kind: 'refresh'; sourceId: string; pdfText?: ManualPdfText }
  | { kind: 'manual'; sourceId: string | null; title: string; text: string }
  | { kind: 'cite'; sourceId: string; revision: string; start: number; end: number }
  | { kind: 'setTranscript'; sourceId: string; revision: string; segments: TranscriptSegment[] }
  | { kind: 'setProjectOnly'; sourceId: string; projectOnly: boolean }
  | { kind: 'conclude'; text: string; citationIds: string[] };
export type ModelPick = { kind: 'palette' | 'site' | 'text' } | { kind: 'research'; sourceIds: string[] } |
  { kind: 'dataset'; offset: number; limit: number };
export type ModelSelection = { linkId: string; nodeId: string; pick: ModelPick };
export type ModelManifestItem = {
  linkId: string; nodeId: string; itemId: string | null; title: string; kind: string; revision: string;
  extraction: string; bytes: number; contentSha256: string; citations: { id: string; start: number; end: number }[];
};
export type ModelProvider = 'forge-test' | 'ollama';
export type ModelReview = {
  id: string; provider: ModelProvider; model: string; endpoint: string | null; bytes: number; limit: number; digest: string;
  requiresSiteApproval: boolean; materials: { manifest: ModelManifestItem; text: string }[];
};
export type ModelResult = { id: string; occurredAt: number; provider: ModelProvider; model: string; digest: string;
  responseSha256: string; text: string; materials: ModelManifestItem[] };
export type SiteBounds = { x: number; y: number; width: number; height: number };
export type SiteAction = 'back' | 'forward' | 'reload' | 'reference' | 'login' | 'discard-login' | 'save-download' | 'cancel-download' | 'dismiss-download' | 'clear';
export type SiteCommand = { action: 'go'; address: string } | { action: SiteAction };
export type SiteState = {
  address: string; title: string; status: string; level: 'ready' | 'error' | 'loading';
  canBack: boolean; canForward: boolean; hasPage: boolean; loginOrigin: string | null; loginOpen: boolean; clearing: boolean;
  download: { phase: 'approval' | 'choosing' | 'saving' | 'saved' | 'error' | 'canceled'; message: string; name: string | null; bytes: number | null } | null;
};
export type LogsPage = LogsHealth & { rows: LogsRow[]; older: LogsCursor | null };

declare global {
  interface Window {
    forge?: {
      build: { version?: string; channel?: string; managed?: boolean };
      uninstall(): Promise<Reply<null>>;
      updates: {
        status(): Promise<Reply<UpdateStatus>>;
        check(): Promise<Reply<UpdateStatus>>;
        stage(selection: UpdateSelection): Promise<Reply<UpdateJob | null>>;
        restart(id: string): Promise<Reply<null>>;
        rollback(id: string): Promise<Reply<null>>;
        onRestarted(listener: () => void): () => void;
      };
      project: {
        create(title: string): Promise<Reply<ProjectView | null>>;
        open(): Promise<Reply<ProjectView | null>>;
        recent(): Promise<Reply<RecentProject[]>>;
        openRecent(id: string): Promise<Reply<ProjectView>>;
        close(): Promise<Reply<null>>;
        archive(id: string): Promise<Reply<boolean>>;
        view(): Promise<Reply<ProjectView>>;
        exportBackup(input: { projectId: string; baseRevision: number }): Promise<Reply<BackupInfo | null>>;
        inspectBackup(): Promise<Reply<{ token: string; info: BackupInfo } | null>>;
        restoreBackup(token: string): Promise<Reply<{ folder: string; projectId: string } | null>>;
        readSettings(): Promise<Reply<SettingsState>>;
        saveSettings(input: { baseRevision: number; snapToGrid: boolean }): Promise<Reply<SettingsState>>;
        exportSettingsBackup(): Promise<Reply<{ name: string } | null>>;
        inspectSettingsBackup(): Promise<Reply<{ token: string; info: SettingsBackupInfo } | null>>;
        restoreSettingsBackup(token: string): Promise<Reply<SettingsState | null>>;
        logsPage(before: LogsCursor | null): Promise<Reply<LogsPage>>;
        exportLogs(): Promise<Reply<true | null>>;
        onLogsHealth(listener: (health: LogsHealth) => void): () => void;
        apply(request: { projectId: string; operationId: string; baseRevision: number; change: ProjectChange }): Promise<Reply<{ revision: number }>>;
        saveViewport(input: { projectId: string; viewport: ProjectViewport }): Promise<Reply<null>>;
        history(before?: number): Promise<Reply<ProjectRevision[]>>;
        importAssets(input: { projectId: string; operationId: string; baseRevision: number; position: ProjectPosition; dropToken?: string; galleryId?: string }): Promise<Reply<ImportResult | null>>;
        galleryPage(input: { projectId: string; nodeId: string; sourceRevision?: string; offset: number; limit: number }): Promise<Reply<AssetPage>>;
        galleryPreview(input: { projectId: string; nodeId: string; sourceRevision: string; versionId: string }): Promise<Reply<AssetPreview>>;
        videoOpen(input: VideoSelection): Promise<Reply<{ src: string }>>;
        videoRelease(src: string): Promise<Reply<null>>;
        linkedAssets(input: { projectId: string; targetId: string; linkId: string; sourceRevision?: string; offset: number; limit: number }): Promise<Reply<LinkedFilePage>>;
        linkedText(input: { projectId: string; targetId: string; linkId: string; sourceRevision?: string }): Promise<Reply<{ sourceRevision: string; text: string }>>;
        researchStatus(input: AnalysisTarget): Promise<Reply<ResearchStatus>>;
        modelReview(input: AnalysisTarget & { provider: ModelProvider; model: string; outputTokens: number; prompt: string; selections: ModelSelection[] }): Promise<Reply<ModelReview>>;
        modelSend(input: AnalysisTarget & { planId: string; approveSite: boolean }): Promise<Reply<ModelResult>>;
        modelCancel(input: AnalysisTarget): Promise<Reply<null>>;
        modelSave(input: AnalysisTarget & { baseRevision: number; operationId: string; resultId: string }): Promise<Reply<{ revision: number }>>;
        transcriptionReview(input: AnalysisTarget & { sourceId: string; revision: string; provider: 'whisper.cpp'; language: TranscriptionLanguage }): Promise<Reply<TranscriptionReview>>;
        transcriptionStart(input: AnalysisTarget & { planId: string; approve: boolean }): Promise<Reply<TranscriptionResult>>;
        transcriptionCancel(input: AnalysisTarget & { planId: string }): Promise<Reply<null>>;
        transcriptionSave(input: AnalysisTarget & { baseRevision: number; operationId: string; resultId: string }): Promise<Reply<{ revision: number }>>;
        researchPreview(input: AnalysisTarget & { sourceId: string; revision: string }): Promise<Reply<AssetPreview>>;
        researchAudio(input: AnalysisTarget & { sourceId: string; revision: string }): Promise<Reply<{ src: string }>>;
        releaseResearchAudio(src: string): Promise<Reply<null>>;
        checklistCompletions(input: { projectId: string; nodeId: string; sourceRevision?: string; offset: number; limit: number }): Promise<Reply<ChecklistRecordPage>>;
        datasetRead(input: { projectId: string }): Promise<Reply<DatasetFile | null>>;
        datasetPreview(input: { projectId: string; text: string; options: DatasetOptions }): Promise<Reply<DatasetPreview>>;
        datasetPage(input: { projectId: string; nodeId: string; query: DatasetQuery }): Promise<Reply<DatasetPage>>;
        datasetExport(input: { projectId: string; nodeId: string; sourceRevision: string; delimiter: DatasetDelimiter }): Promise<Reply<boolean>>;
        schemeRead(input: { projectId: string }): Promise<Reply<{ name: string; document: SchemeDocument } | null>>;
        schemeGraph(input: { projectId: string; nodeId: string; sourceRevision?: string }): Promise<Reply<SchemeGraph & { sourceRevision: string }>>;
        schemeExport(input: { projectId: string; nodeId: string; baseRevision: number }): Promise<Reply<boolean>>;
        siteAttach(input: { projectId: string; nodeId: string; lease: string }): Promise<Reply<boolean>>;
        siteDetach(lease: string): Promise<Reply<boolean>>;
        siteBounds(input: { lease: string; bounds: SiteBounds | null }): Promise<Reply<boolean>>;
        siteCommand(input: { lease: string } & SiteCommand): Promise<Reply<boolean | SitePage>>;
        onSiteState(listener: (value: { lease: string; state: SiteState }) => void): () => void;
        runPalette(input: AnalysisRun & { colors: PaletteColors }): Promise<Reply<PaletteSummary>>;
        cancelAnalysis(input: { projectId: string; operationId: string }): Promise<Reply<boolean>>;
        paletteStatus(input: AnalysisTarget): Promise<Reply<AnalysisStatus<PaletteSummary>>>;
        paletteHistory(input: AnalysisTarget & { before?: number }): Promise<Reply<AnalysisHistoryItem<PaletteSummary>[]>>;
        paletteFiles(input: AnalysisTarget & { resultId: string; offset: number; limit: number }): Promise<Reply<PalettePage>>;
        runMetadata(input: AnalysisRun): Promise<Reply<MetadataSummary>>;
        metadataStatus(input: AnalysisTarget): Promise<Reply<AnalysisStatus<MetadataSummary>>>;
        metadataHistory(input: AnalysisTarget & { before?: number }): Promise<Reply<AnalysisHistoryItem<MetadataSummary>[]>>;
        metadataFiles(input: AnalysisTarget & { resultId: string; offset: number; limit: number }): Promise<Reply<MetadataPage>>;
        metadataLocation(input: AnalysisTarget & { resultId: string; versionId: string }): Promise<Reply<ExifLocation | null>>;
        comparisonChoices(input: AnalysisTarget & { linkId: string; sourceRevision?: string; offset: number; limit: number }): Promise<Reply<ComparisonChoices>>;
        runComparison(input: AnalysisRun & { left: ComparisonSelection; right: ComparisonSelection }): Promise<Reply<ComparisonSummary>>;
        editorPreview(input: AnalysisRun & { graph: EditorGraph; selection?: EditorSelection }): Promise<Reply<EditorPreview>>;
        editorExport(input: EditorExportInput): Promise<Reply<ImportResult | null>>;
        comparisonStatus(input: AnalysisTarget): Promise<Reply<AnalysisStatus<ComparisonSummary>>>;
        comparisonHistory(input: AnalysisTarget & { before?: number }): Promise<Reply<AnalysisHistoryItem<ComparisonSummary>[]>>;
        comparisonLines(input: AnalysisTarget & { resultId: string; offset: number; limit: number }): Promise<Reply<ComparisonLines>>;
        comparisonPreview(input: AnalysisTarget & { resultId: string; side: 'left' | 'right' | 'difference' }): Promise<Reply<AssetPreview>>;
        cancelImport(input: { projectId: string; operationId: string }): Promise<Reply<boolean>>;
        onImportProgress(listener: (progress: ImportProgress) => void): () => void;
        directoryList(input: { projectId: string; nodeId: string; folder: string[] }): Promise<Reply<DirectoryListing>>;
        gitBind(input: GitCard): Promise<Reply<GitSnapshot | null>>;
        gitUnbind(input: GitCard): Promise<Reply<null>>;
        gitRead(input: GitCard): Promise<Reply<GitSnapshot | null>>;
        gitDiff(input: GitCard & { path: string; side: GitSide; revision: string }): Promise<Reply<GitPatch>>;
        gitMutate(input: GitCard & { action: GitAction; revision: string }): Promise<Reply<GitSnapshot>>;
        changeDirectory(input: { projectId: string; nodeId: string; baseRevision: number; change: DirectoryChange }): Promise<Reply<boolean>>;
        previewAsset(input: AssetSelection): Promise<Reply<AssetPreview>>;
        openAsset(input: AssetSelection): Promise<Reply<{ kind: 'image'; src: string } | { kind: 'external' }>>;
        releaseImage(src: string): Promise<Reply<null>>;
        documentEditState(input: AssetSelection): Promise<Reply<DocumentEditState | null>>;
        openEditCopy(input: AssetSelection): Promise<Reply<DocumentEditState | null>>;
        importEditCopy(input: AssetSelection & { operationId: string; baseRevision: number }): Promise<Reply<{ revision: number } | null>>;
        revealEditCopy(input: AssetSelection): Promise<Reply<null>>;
        discardEditCopy(input: AssetSelection): Promise<Reply<boolean>>;
        readAssetText(input: AssetSelection): Promise<Reply<string>>;
        editTextAsset(input: AssetSelection & { operationId: string; baseRevision: number; text: string }): Promise<Reply<{ revision: number }>>;
        downloadAsset(input: AssetSelection): Promise<Reply<boolean>>;
        replaceAsset(input: AssetSelection & { operationId: string; baseRevision: number }): Promise<Reply<{ revision: number } | null>>;
        onFileDrop(listener: (drop: FileDrop) => void): () => void;
      };
    };
  }
}

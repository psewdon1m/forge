# Desktop IPC v1

The primary Forge frame calls the application preload through `window.forge.project`. Main checks the sender and local document URL. Site WebContents views get no Forge preload. Core runs as an app-owned process over bounded line-delimited JSON on stdio. The renderer does not spawn processes or pass a folder path to a project picker command.

| UI command | Contract |
| --- | --- |
| `create(title)`, `open()` | Show the native folder chooser. Cancel returns a successful null result. Open errors leave the current workspace intact. |
| `recent()` | Return up to twenty entries with project ID, title and last opened UTC time. Folder paths stay in main. |
| `openRecent(id)` | Resolve the saved folder by ID and require the same ID in Core before switching the current project. A moved project can be located through Open project. |
| `view()`, `close()` | Read the active canonical snapshot and viewport, or release the writer lock. |
| `apply({projectId, operationId, baseRevision, change})` | Main matches the active project ID. Core checks the base revision and idempotency key and persists the structural change. Moving a selection, pasting or archiving a group uses a single revision. |
| `saveViewport({projectId, viewport})` | Check the same project ID and store geometry of the view without adding a structural revision. |
| `history(before?)` | List up to 100 revisions from newest to oldest, using an exclusive cursor. Restore is an explicit structural `restoreRevision` command. Separate `undo` and `redo` commands consult the persisted reversal targets and append a revision. `view` publishes their availability. |
| `importAssets({projectId, operationId, baseRevision, position, dropToken?, galleryId?})` | Uses the native picker or consumes a project-scoped token from the isolated preload. A Gallery drop carries the target panel's card ID. Main forwards selected paths and the optional Gallery target to Core. Returns per-file results and the new revision when a file is accepted. |
| `onImportProgress(listener)` | Reports current file index, byte count and size, then the commit phase. Every event carries the active operation ID. Source paths stay in main and Core. |
| `cancelImport({projectId, operationId})` | Requests cancellation of the active import before its commit boundary. The import result reports `IMPORT_CANCELED` after cleanup. A request arriving during commit has no effect. |
| `importAssets({...input, galleryId})` | Targets an existing Gallery. Accepts images and adds managed references in order without creating File cards. Continuation and cancel behavior match Space import. |
| `galleryPage({projectId, nodeId, sourceRevision?, offset, limit})` | Returns a bounded page of asset references and the revision of the ordered Gallery. |
| `galleryPreview({projectId, nodeId, sourceRevision, versionId})` | Verifies a current Gallery member and returns a bounded PNG data URL. |
| `linkedAssets({projectId, targetId, linkId, sourceRevision?, offset, limit})`, `linkedText({projectId, targetId, linkId, sourceRevision?})` | Read the registered provider through the active typed link. Core checks the target and expected source revision. Directory rows add relative path and Windows fingerprint, allow an unknown format, and withhold the content hash until a verified read. The file page can report the count of unavailable entries. |
| `runPalette({projectId, targetId, operationId, baseRevision, colors})` | Run an explicit calculation against a live ImageCollection input on a Palette card. Successful results are immutable and carry the exact source revision and result digest. |
| `cancelAnalysis({projectId, operationId})` | Signal the matching active analysis. If accepted before the commit boundary, the run replies `CANCELLED`. Previously committed results stay available. |
| `paletteStatus({projectId, targetId})`, `paletteHistory({projectId, targetId, before?})` | Return the source check and latest result summary, or up to 30 earlier result summaries using an exclusive history cursor. |
| `paletteFiles({projectId, targetId, resultId, offset, limit})` | Read up to 100 file palettes recorded in a successful result owned by this Palette. This operation reads immutable result data independent of the live link. |
| `runMetadata({projectId, targetId, operationId, baseRevision})` | Verify the files in a connected FileCollection or ImageCollection and record a Metadata result with provenance. Uses the same cancellation boundary as Palette. |
| `metadataStatus({projectId, targetId})`, `metadataHistory({projectId, targetId, before?})` | Return the current source check and latest summary, or up to 30 earlier Metadata summaries using the exclusive history cursor. |
| `metadataFiles({projectId, targetId, resultId, offset, limit})` | Return up to 100 recorded Metadata rows for the matching card and result. Coordinates are excluded. |
| `metadataLocation({projectId, targetId, resultId, versionId})` | Read EXIF coordinates for an explicitly selected image version in the latest current result. Verifies the live link, current source membership and original hash. Returns coordinates or null if the file has no supported position. |
| `comparisonChoices({projectId, targetId, linkId, sourceRevision?, offset, limit})` | List up to 100 file or note choices from the matching live link and return its revision. |
| `runComparison({projectId, targetId, operationId, baseRevision, left, right})` | Each side supplies its link ID, source revision and version ID, or null version for a Note. Core verifies the two sources and commits the text or image result with provenance. |
| `comparisonStatus({projectId, targetId})`, `comparisonHistory({projectId, targetId, before?})` | Return the status against both saved source revisions and the latest successful result, or earlier results with an exclusive history cursor. |
| `comparisonLines({projectId, targetId, resultId, offset, limit})` | Read up to 100 recorded diff rows with separate left and right line numbers. |
| `comparisonPreview({projectId, targetId, resultId, side})` | Verify that the live link of the requested side still provides the stored image version. Returns its verified bounded PNG preview. |
| `directoryList({projectId, nodeId, folder})` | Lists one project folder for the selected Directory Portal. Paths are arrays of relative name components. Replies include a folder version and a version for each available entry. |
| `changeDirectory({projectId, nodeId, baseRevision, change})` | Checks the Directory Portal, Space revision and selected entry or folder versions. Create, rename and move receive validated names or destinations. Delete confirms in Windows and returns `false` on cancellation. Successful filesystem mutations return `true` without changing Space revision. |
| `previewAsset({projectId, nodeId, versionId})` | Matches the active project, current card, and registered version. Returns a verified text prefix, a generated PNG data URL, or a document integrity result. |
| `openAsset({projectId, nodeId, versionId})` | Prepares a verified read-only copy. Returns a renderer-scoped image address or confirms dispatch to the Windows default app. |
| `releaseImage(src)` | Revokes that image address and releases its temporary copy. |
| `documentEditState({projectId, nodeId, versionId})` | Returns the working-copy state for this card and whether it belongs to an earlier version. The filesystem location stays in main. |
| `openEditCopy({projectId, nodeId, versionId})` | Confirms materializing a writable PDF/DOCX copy, then invokes the Windows editor chooser. Returns the copy status or `null` on cancellation. |
| `importEditCopy({projectId, nodeId, versionId, operationId, baseRevision})` | Confirms a reimport from the registered working copy. Returns the new revision or `null` on cancellation. Stale copies remain available for recovery. |
| `revealEditCopy(input)`, `discardEditCopy(input)` | Open the registered working-copy folder in Windows or request explicit confirmation to discard the working copy. Both accept the same card selection as `documentEditState`. |
| `downloadAsset({projectId, nodeId, versionId})` | Matches the same selection and opens the native Save dialog with the registered filename and format. Returns `true` after Core verifies and publishes the original or `false` if the user cancels. Paths and original bytes stay outside the renderer. |
| `replaceAsset({projectId, nodeId, versionId, operationId, baseRevision})` | Opens the native single-file picker with the current format. Core validates the selected bytes and the card and revision preconditions. Returns the committed revision or `null` if canceled. |
| `readAssetText({projectId, nodeId, versionId})` | Returns the verified complete UTF-8 text for the current TXT or Markdown version within the editor limit. |
| `editTextAsset({projectId, nodeId, versionId, operationId, baseRevision, text})` | Verifies the current TXT or Markdown version, expected revision and new UTF-8 bytes. Publishes a new immutable version and returns the committed revision. |
| `exportBackup({projectId, baseRevision})` | Opens a native ZIP Save dialog for the active project. Returns the verified manifest summary after atomic publication, or `null` if canceled. |
| `archive(projectId)` | Confirms the active project's archival in the native modal. Removes its recent entry and closes it. Returns `false` on cancellation. Opening the folder explicitly adds it to the recent catalog again. |
| `inspectBackup()` | Opens a native ZIP picker and streams the archive through Core validation. Returns a manifest summary and an opaque inspection token, or `null` if canceled. A new inspection invalidates the previous token. |
| `restoreBackup(token)` | Chooses a parent directory in a native picker. Core verifies the inspected archive hash and publishes a new project with unique identity. Main records the copy in Recent Projects. Returns the new project ID and folder name or `null` if canceled. |
| `logsPage(before)` | Returns up to 200 audit events in newest-first order, an optional older cursor and the diagnostics health flags. Pass `null` for the latest page. |
| `exportLogs()` | Opens a native Save dialog for the redacted diagnostics ZIP. Returns `true` after atomic publication or `null` on cancellation. |
| `onLogsHealth(listener)` | Subscribes to diagnostics write-loss and low-storage state. Returns an unsubscribe function. |
| `readSettings()` | Reads the portable application preferences and local settings revision from the current OS-user profile. |
| `checklistCompletions({projectId,nodeId,sourceRevision?,offset,limit})` | Reads checked tasks and groups in the opened project. Returns the current source revision, total and next page offset. |
| `datasetRead({projectId})`, `datasetPreview({projectId,text,options})` | Uses a native CSV/TSV picker for the first action. Validates the bounded UTF-8 snapshot or pasted input, including rows past the preview limit. |
| `datasetPage({projectId,nodeId,query})` | Reads a bounded TabularData page with a source revision, typed and raw values, stable row IDs, and optional sorting and filtering. |
| `datasetExport({projectId,nodeId,sourceRevision,delimiter})` | Uses a native Save dialog to write the complete verified Dataset with safe-text handling. |
| `schemeRead({projectId})` | Uses a native picker to validate a bounded Scheme JSON file for the active project and return its draft document and display name. |
| `schemeGraph({projectId,nodeId,sourceRevision?})` | Reads the active project's saved Scheme elements and connections, with a content revision independent of the current view. A mismatched expected revision returns `SOURCE_CHANGED`. |
| `schemeExport({projectId,nodeId,baseRevision})` | Uses a native Save dialog and publishes the saved Scheme JSON at the specified project revision. |
| [`siteAttach({projectId,nodeId,lease})` and `siteDetach(lease)`](site-profile.md) | Bind a Site browser to a saved card in the active project. Detach removes its native view and cancels pending interactions. |
| `siteBounds({lease,bounds})` and `onSiteState(listener)` | Pass clipped bounds from the trusted UI and receive state for the same lease. |
| `siteCommand({lease,action,...})` | Perform a browser command for the matching active Site, show the trusted download picker or clear confirmation, or prepare the sanitized reference preview. |
| `saveSettings({baseRevision, snapToGrid})` | Commits the grid preference against the expected settings revision and returns the new state. |
| `exportSettingsBackup()` | Uses a native ZIP Save dialog and returns the saved filename after verification, or `null` if canceled. |
| `inspectSettingsBackup()` | Returns the sanitized settings summary and an opaque token after validating the selected ZIP, or `null` if canceled. |
| `restoreSettingsBackup(token)` | Confirms replacement in a native dialog, then checks the hash and destination settings revision captured at inspection. Returns committed state or `null` if canceled. |
| [`updates.status()`, `updates.check()`](update-discovery-v1.md) | Read the active native updater and installed version, or begin a fresh Stable metadata check. Neither call accepts a repository, URL or candidate from the renderer. |
| [`updates.stage({version, packageSha256})`](update-staging-v1.md) | Prompts for a backup destination, stages the selected release and hands the prepared job to the launcher. Returns `null` if the Save dialog was canceled. |
| [`updates.restart(jobId)`](update-activation-v1.md) | Reopens the original backup ZIP through the native picker and requests restart for the current staged job. |
| [`updates.rollback(jobId)`](update-activation-v1.md#manual-rollback) | Opens the job's original backup ZIP through the native picker and restarts into the verified previous slot after recovery checks. Canceling the picker returns `null`. |

Success returns `{ok:true,value}` and can include a catalog warning. Failure returns `{ok:false,error:{code,message,currentRevision?,correlationId?}}`. A revision conflict carries the current revision. Audited failures include a generated correlation ID for lookup in Logs. Recent opening verifies that the saved location still belongs to the registered project.

The recent catalog is stored in the OS-user app-data directory as `recent-projects.json`. It is advisory metadata. Its absence, truncation or write failure does not alter canonical project contents. A successful open records the new location and refreshes the display name. Project title changes, including restoration of an older title, refresh the last known name.

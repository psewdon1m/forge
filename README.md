# Forge

Forge is an autonomous Windows desktop workspace. A project owns a local directory, a Space canvas and optional Plains. The current development build supports local projects, file analysis, research, backup and recovery.

[Production plan](.docs/Forge_Production_Plan_v0.1.md) · [Concept](.docs/Forge_Concept_v0.1.md) · [Platform verification](docs/contracts/platform-matrix.md)

## Local development

Prerequisites: Windows x64, Node.js 24.14.0, npm 11.9.0, Git for Windows and Rust 1.94.1 with a native Windows toolchain. The Site fixture uses the OpenSSL installed with Git for Windows. Set `FORGE_TEST_OPENSSL` if it lives at a different absolute path.

1. Run `./scripts/setup.ps1` in PowerShell.
2. Build Core using `cargo build --locked --release -p forge-core` and copy `target/release/forge-core.exe` to `.local/bin/`. On a development machine with Docker Desktop and no native Rust compiler, run `./scripts/build-core-windows-dev.ps1` instead.
3. Run `./scripts/dev.ps1`. Go to **Projects**, enter a name, and choose an empty local directory. Add a note or a Checklist from **Space**. Use **Recent projects** to reopen it or **Open project** to find it after moving the folder. Open **Logs** to inspect revisions or restore one as a new revision.
4. Run `./scripts/verify.ps1 -Suite All` and `node tests/project-desktop.mjs` for verification of the current scope. The performance harness runs separately via `node tests/space-benchmark.mjs` after building the UI. Evidence stays under `.local/qualification/`.

The development runtime starts from local packaged UI files. Use **Load sample** in the blank workspace to view the synthetic Space. The installed launcher provides the update workflow.

Shift-click to select multiple Space objects, then use **Group** to keep their positions together. The arrow keys move a selection when a card or its actions have focus. **Copy** and **Paste** duplicate a selection inside Forge. **Undo** and **Redo** append revisions, and **Archive** in the object actions removes a selection from Space while keeping its snapshots in history.

Open a card and use **Open beside** to add another working panel. Both panels are visible at widths of 1,120 px or more. In a narrower window, **Show** switches between them while keeping independent selections, filters and drafts. Close either panel to continue in the other or choose **Back to Space** to close the pair.

Use **Import files** or drop files onto an open Space to add PNG, JPEG, WebP, WebM, MP4, TXT, Markdown, PDF, DOCX or PCM WAV. Check the per-file report and open a committed card to inspect its type, size and SHA-256. Run `node tests/asset-desktop.mjs` after building the desktop and Core to verify the picker and drop workflow. [File lifecycle](docs/contracts/file-lifecycle.md)

For DOCX and PDF, **Open file** sends a read-only copy to the default app. Use **Edit copy** to open a writable copy and **Import changes** to save it as a new version. Check the editor matrix for the formatting preserved by tested versions. [Document editor matrix](docs/contracts/document-editor-matrix.md)

Use **Add Directory** in Space to browse project files, create folders, and rename or move entries. Delete asks for confirmation and applies to files and empty folders. Run `node tests/directory-core-windows.mjs` and `node tests/directory-desktop.mjs` to verify filesystem isolation and the desktop workflow. [Directory Plain](docs/contracts/file-lifecycle.md#directory-plain)

Use **Add Gallery** to import images and videos or select media already in Space. Video tiles show a poster and open a local player. Connect Gallery's images port to **Palette**, choose 4, 8 or 16 colors, and select **Calculate**. Palette reports how many videos it skipped. [Gallery playback](docs/contracts/file-lifecycle.md#gallery-and-file-video) · [Data Links contract](docs/contracts/data-links-v1.md)

Connect File or Gallery to **Metadata** and select **Calculate** to inspect the files. Select a row to see its exact version, hash and available image fields. Images with EXIF coordinates offer **Show EXIF location** in a current result. Run `node tests/metadata-desktop.mjs` to verify the workflow. [Metadata contract](docs/contracts/data-links-v1.md#metadata)

Connect File, Gallery or Note to **Comparison**, select two different items and select **Calculate**. Compare lines from notes, TXT, Markdown, DOCX or PDF. Image pairs show both previews and a pixel difference for matching dimensions up to four million pixels. [Comparison contract](docs/contracts/data-links-v1.md#comparison)

Connect the **Directory** files port to Metadata or Comparison to analyze the project tree. **Check source** checks for external edits. In Comparison it also refreshes the choices. Run `node tests/directory-source-desktop.mjs` to verify the workflow and access boundaries. [Directory source contract](docs/contracts/data-links-v1.md#directory)

Use **Add Scheme** to draw a diagram, connect shapes and save it with the project. **Export Scheme JSON** and **Open Scheme JSON** exchange the editable diagram using the open v1 format. Connect its text port to Comparison to compare labels. [Scheme contract](docs/contracts/scheme-v1.md)

Use **Add Editor** to link an image version and build a recipe from Crop, Resize, Exposure and Color adjustment nodes. Render a draft preview, save the recipe and confirm a PNG or JPEG export to make a new project file. [Editor contract](docs/contracts/editor-v1.md)

Use **Add Git** and choose the root of an existing working tree. Review the staged and unstaged changes, create a local commit, or switch branches from a clean working tree. Open remote hosting in Site. [Git Plain](docs/contracts/git-plain.md)

Use **Add Site** to browse an HTTPS source in an isolated profile. **Capture current page** previews a reference for an optional manual quote and a project save. [Site profile](docs/contracts/site-profile.md)

Use **Add Research** and connect a TXT, Markdown or PDF file, a saved Site quote, text, or an image. Research captures selected material, preserves old versions and lets you cite a selection from a saved version. For PDFs with no readable text layer, **Enter PDF text** saves your excerpt with the exact attachment. Search covers titles and text in saved versions. Project backups include the research and its managed attachments. [Research source provenance](docs/contracts/source-provenance.md)

Connect a PCM WAV file to Research to listen to the saved recording and add a versioned transcript. Enter start and end times in seconds. Select a time range to seek in the recording, or select text to cite the transcript. [Research audio and transcripts](docs/contracts/source-provenance.md#local-audio-and-transcripts)

If whisper.cpp is running locally, choose **Transcribe automatically** to review the exact WAV and approve sending it to the local provider. Review the proposed segments before saving them as a new Research version. [Automatic transcription setup](docs/contracts/source-provenance.md#automatic-transcription)

Use **Add Intelligent** to review material from linked Palette, Research, Dataset, saved Site quotes and text. Choose the local test provider or an installed Ollama model on this computer. Review exact inputs before sending and save responses explicitly to the project. [Model context and provider workflow](docs/contracts/model-context.md)

The Windows release harness builds and verifies a test-signed bootstrap and exact ZIP locally. [Release runbook](docs/runbooks/release.md)

Open **Settings → Updates** from the installed launcher to check the signed Stable channel. Select the exact version and save a new backup ZIP to verify, stage and start the release. Settings shows the startup result after restart. [Discovery](docs/contracts/update-discovery-v1.md) · [Update preparation](docs/contracts/update-staging-v1.md) · [Startup and recovery](docs/contracts/update-activation-v1.md)

A completed update with a verified previous slot offers **Roll back to** in Settings. Select the original ZIP that Forge saved for that update. The launcher verifies the previous version and restores the archived settings. [Recovery guide](docs/runbooks/recovery.md#roll-back-from-settings)

Open **Settings → Backup** to export a project, inspect a ZIP and restore a copy. **Logs → Local diagnostics** shows retained operations and can export a sanitized diagnostics ZIP. [Recovery guide](docs/runbooks/recovery.md) · [Diagnostics guide](docs/runbooks/diagnostics.md)

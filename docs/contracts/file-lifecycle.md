# File lifecycle

## Import

**Import files** in Space uses the OS picker. A file drop in the same Space uses Electron's filesystem-backed `File` handles in the isolated preload. The renderer gets a short-lived token and coordinates for the drop. The token can be used once in the project that received it. Main supplies the resulting filesystem paths to Core through the same import command for both entry points.

For a Gallery drop, the isolated preload also reports the card ID of the drop target. With two Galleries open, dropping onto one imports to that Gallery. Core validates the current target and accepts the Gallery media formats.

Core accepts up to 50 local files, 128 MiB per file and 512 MiB of input per batch. It opens each source once without following a terminal symbolic link, streams the bytes into an isolated staging directory, and rejects a change to the file's length or modification time while reading it. The selected filename is display data. A fresh asset ID and version ID identify each accepted input, including inputs that share a filename.

| Format | Validation at import |
| --- | --- |
| PNG, JPEG, WebP | Extension matches the detected format. Header dimensions and full decode stay within a 40 megapixel and bounded allocation profile. |
| TXT, MD | Nonempty, UTF-8 text with no NUL bytes. |
| PDF | PDF header and terminal EOF marker. Actual rendering is a separate viewer check. |
| DOCX | ZIP with bounded entry count and expanded sizes, safe entry paths, and readable XML in the required content-types and Word document parts. The importer validates parts without extracting archive entries. |
| WAV | RIFF/WAVE with one or two PCM channels, 8,000–192,000 Hz and 8, 16, 24 or 32 bits per sample. Format and data headers must appear in the first 64 KiB. Core checks the stream length, block alignment and duration. |
| WebM | Core checks the bounded EBML header, WebM document type and segment. The qualified profiles are VP8/Opus and VP9/Opus. |
| MP4 | Core checks top-level ISO BMFF box sizes, file type, movie box and sample data. The qualified profile is H.264/AAC. |

The authoritative snapshot records name, format, byte length and SHA-256 with asset and version IDs. SQLite records immutable versions and import intents. Managed paths are generated under `assets/` relative to the opened project directory, with staging under `.forge/staging/`. Directory capability handles confine staging and publication. Publishing uses a no-overwrite hard link on the project filesystem. If it fails, the asset cannot become a reference in Space.

An import batch accepts or rejects each file independently. All accepted files and their cards appear in one revision after database commit. Cancellation in the picker creates no revision. An operation ID replays its original batch result. In an interrupted import, the outstanding intent identifies the exact staged location and any candidate blob. On reopen, Core discards unfinished staged bytes and removes an uncommitted published blob only after checking its recorded length and SHA-256. The accepted revision and intents are updated in the same database transaction.

During an import, Space shows the current file number and bytes copied. Core copies and hashes the input in 64 KiB chunks while Desktop can still read the Projects dashboard. **Cancel import** signals Core independently of queued commands. Core checks the signal between copy chunks and before the commit boundary. Cancellation rolls back the entire uncommitted batch, including already copied candidates, and leaves the operation available for retry. **Finishing import** marks the boundary where the transaction proceeds to a complete result. Space keeps the progress view available until the import reports its result. The Windows `import-progress-desktop.mjs` check reads the dashboard after a large copy starts, cancels the batch and confirms that the previous revision remains intact.

Asset versions referenced in project history are retained when a card is archived or undone. Copy within the project can share an immutable asset version. The asset registry rejects a reference to an unrecognized version. Backup must preserve both version metadata and the managed bytes.

## Preview and Download

Core resolves a file through the current Space using its card ID and version ID, then matches the card reference to the SQLite registry. It opens the managed original without following a terminal symbolic link and checks its entire length and SHA-256 before returning any preview or publishing a copy. A stale card or version returns `ASSET_UNAVAILABLE`. A missing or modified original returns `ASSET_INTEGRITY`. Reading and downloading add no revision.

The File view displays a read-only, literal UTF-8 preview of TXT and MD up to 64 KiB, ending on a character boundary. PNG, JPEG and WebP previews are decoded under the import limits and returned as generated PNGs up to 512 pixels on each edge. PDF, DOCX, WAV, WebM and MP4 display integrity status and file details. A linked WAV can play in Research. [Research audio and transcripts](source-provenance.md#local-audio-and-transcripts)

## Gallery and File video

Choose **Import media** in Gallery or add a file already in Space. Gallery generates the first decoded frame as a temporary PNG poster up to 360 pixels per edge. Choose **Open video** on the tile or File card to play and seek with the local controls. The player checks picture dimensions up to 8192 pixels per edge and 16,777,216 total pixels. A missing picture or unavailable codec shows an explicit playback error. [Chromium media](https://www.chromium.org/audio-video/)

Core checks the currently selected asset version, Gallery membership and source revision before it exports a verified read-only copy. The player uses an opaque URL and bounded byte ranges in the primary app frame. Closing the player, changing a Gallery's membership, leaving the project or reaching the one-hour expiry ends the stream and revokes new reads. The renderer owns frames it has already decoded. ZIPs contain the original managed bytes and Gallery membership. Posters are recreated from those bytes on reopen. [Electron protocol streaming](https://www.electronjs.org/docs/latest/api/protocol)

Projects and ZIPs with managed video require a Core that recognizes the WebM and MP4 asset types. To qualify rollback with video projects, exercise both slots against backups that contain these types.

Run `node tests/gallery-video-desktop.mjs` for decoded posters, playback, seeking, revocation, Palette and clean-profile ZIP restore. The fixtures are synthetic 128 × 64 swatches with a 300 Hz tone. They were generated with Debian FFmpeg 5.1.9 and probed for their video and audio tracks. [FFmpeg package](https://packages.debian.org/bookworm/ffmpeg)

**Download original** presents a native Save dialog. The destination stays in the trusted Desktop and Core processes. Core streams the original to a temporary file in the chosen destination folder. It verifies and flushes the copy before publishing it under the chosen name using a no-overwrite hard link. This operation requires a destination filesystem that supports hard links. The extension must match the asset format. A filename collision leaves the existing file intact and asks the user to choose another name. A rejected copy removes its temporary file during normal execution. Closing the dialog performs no filesystem write.

## Open

**Open file** makes a new verified, read-only copy in the user's Forge app data. Only desktop main and Core receive the filesystem path. A length or hash mismatch leaves the file unopened and removes the temporary copy. Opening adds no project revision.

PNG, JPEG and WebP open in the File view with **Fit image** and **Actual size**. A short-lived `forge-image:` address streams the original with the registered MIME type. Desktop permits image loads from the main frame only. The address is revoked on Close image, leaving the File view, project switch, normal quit or after one hour. Copies left by an interrupted process are collected on a later startup after 24 hours.

**Open file** sends TXT, Markdown, PDF, DOCX, WAV, WebM and MP4 to the operating system's default handler for the format. The read-only copy expires after 24 hours. A failed launch removes the copy and explains how to set an app for the format or download the verified original. A default viewer can delegate or decline the file.

| Format | Viewer | Editor |
| --- | --- | --- |
| PNG, JPEG, WebP | Forge File view with original dimensions. | Replace with a validated file of the same format. |
| TXT, Markdown | Forge text preview and Windows default handler for Open. | Forge text editor up to 256 KiB. |
| PDF | Registered Windows PDF handler. | Edit copy and import. The editor matrix records the tested Draw workflow and the remaining chooser checks. |
| DOCX | Registered Windows DOCX handler. The editor matrix records the tested WordPad behavior. | Edit copy and import. The editor matrix records the tested Writer workflow and the remaining chooser checks. |

[Document editor matrix](document-editor-matrix.md)

## Replace

**Replace file** opens a native picker with the current format filter. Core checks the selected card's version and the expected project revision. A replacement must match the current format, including its validated content. Canceling or rejecting a file leaves the current version and revision intact.

Successful replacement keeps the same card ID, position, group membership and asset ID. It publishes a fresh version ID, updates the filename and creates one project revision. Publication uses the same staging and recovery rules as import. Undo and Redo restore the corresponding reference and bytes. Other cards that share the previous version keep their references. An exact replay of a committed operation returns its recorded revision.

## Edit text

**Edit text** opens a literal UTF-8 editor for TXT and Markdown files up to 256 KiB. The size limit applies to both the source and its new UTF-8 serialization. Empty input and NUL characters are rejected. The editor preserves a UTF-8 BOM and a single existing line-ending style. A file with mixed line endings is saved using LF, with a notice in the editor.

Core checks the current project revision, card and registered version before writing. It verifies the original again at save time. Saving changed text uses the same staging and publication as replacement, keeps the filename and creates a new immutable version. Editor failures keep the unsaved text in the open File view. Leaving that view requires saving or discarding changes.

## Edit PDF or DOCX copy

**Edit copy** confirms the operation before Core exports verified content to a writable file under Forge app data. Windows **Open with** asks the user to select an installed editor. Choose a program that saves the document in its original format. Forge retains the workspace and source file independently of the Windows editor.

If the chooser fails during a new edit, Forge removes the unused working copy and keeps the selected version. Download the file, edit it in the same format and choose **Replace file** to import the result. If reopening an existing working copy fails, choose **Open copy folder** to recover the file. Forge shows the Windows error code when the chooser reports one.

Save and close the file in the external editor, then select **Import changes** and confirm. Core checks the expected project revision and original file version, verifies the original's digest, and applies the same size, format and content checks used for import. Unchanged bytes and invalid edits leave the revision intact. Success publishes one new version with the same Asset ID, card ID and original filename.

The working copy and its manifest survive a Forge restart. If another version is active on the card, **Open copy folder** lets the user recover the working file. Undo can restore the version that the copy belongs to. Successful import also preserves the working file. **Discard copy** explicitly confirms removal. Editor-created side files stay in the copy folder for recovery.

## Directory Plain

**Add Directory** adds an optional `forge.directory` version 1 Portal to Space. Each card opens the project root. Browsing and folder actions use arrays of relative name components. Forge confines them to the project handle and keeps the root `.forge/` and `assets/` storage private. Unavailable entries appear without actions. Windows reparse points and files with multiple hard links are unavailable.

Directory shows file sizes and supports folder creation, rename, move within the project, and deletion of files or empty folders. Creation and rename submit the entered name. Move submits the browsed destination. Delete presents a Windows confirmation that defaults to Cancel. Operations have a 32-level depth limit and lists have a 2,000-entry limit per folder. Core checks the active Directory Portal and expected Space revision before changing the filesystem.

Directory entry versions include filesystem identity, attributes, size and Windows creation, write and change times. Regular-file versions for rename, move and delete also include the file's change-journal sequence when available. On volumes without an available sequence, Core reads the file under a handle that denies writers and hashes its contents. Core checks that same version before changing the file. It validates the destination folder version for moves and the parent version for creation. Source handles deny new writers and renames during mutation. Parent handles pin the resolved project path. Windows performs rename and move with no replacement, and applies deletion only to the open object. Directory leaves image and document history in the asset store. Space Undo applies to card changes and does not revert filesystem changes.

Real DOCX/PDF editor round trips and native PDF rendering remain F02 qualification work.

## Recovery qualification

Run `node tests/asset-crash-windows.mjs` against the built Windows Core. The fixture terminates Core after it publishes one uncommitted blob and begins writing the next. Reopening must preserve the earlier revision and original, remove the two incomplete results, and allow the same operation to commit on retry.

To qualify storage exhaustion on Linux, mount an isolated 16 MiB tmpfs at `/forge-full-test` and run `cargo test --locked --test assets import_handles_real_storage_exhaustion -- --ignored --nocapture`. The fixture must return `STORAGE_FULL`, preserve the committed revision and original, clean the partial stage, and accept a later smaller import.

For native Windows, `./scripts/verify-ntfs-storage-full.ps1` uses an elevated PowerShell and the built Core. It creates and verifies a new 64 MiB VHDX, limits the test to its NTFS partition, and detaches that exact image when finished. A 96 MiB source must trigger `STORAGE_FULL` during copying. The previously saved bytes must survive reopening and a smaller retry must succeed.

Sources: [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils), [Electron protocol](https://www.electronjs.org/docs/latest/api/protocol), [Electron webRequest](https://www.electronjs.org/docs/latest/api/web-request), [Electron shell](https://www.electronjs.org/docs/latest/api/shell), [Windows Open with](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenwithdialog), [Windows file information](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle), [image decoder limits](https://docs.rs/image/0.25.10/image/struct.ImageReader.html), [cap-std](https://docs.rs/cap-std/4.0.3/cap_std/fs/struct.Dir.html).

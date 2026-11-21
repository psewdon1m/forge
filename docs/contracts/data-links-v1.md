# Data Links v1

Space stores a link's UUID, source node and port, target node and port, data type, contract version and read-only access. Core resolves port declarations against the current project. It rejects missing endpoints, unknown or incompatible ports, duplicate and self-links, exhausted inputs and directed cycles. Unknown Plains can retain existing link shapes in project snapshots. They cannot start a new link or serve data without a registered provider.

| Plain or asset | Outputs | Inputs |
| --- | --- | --- |
| Image file | `files` FileCollection, `images` ImageCollection | |
| TXT or Markdown file | `files` FileCollection, `text` TextContent | |
| Other file | `files` FileCollection | |
| Note | `text` TextContent | |
| Checklist | `text` TextContent, `completions` ChecklistCompletionRecords | |
| Dataset | `rows` TabularData | |
| [Scheme](scheme-v1.md) | `text` TextContent, `graph` GraphData | |
| [Site](site-profile.md) | `quote` TextContent | |
| Gallery | `files` FileCollection, `images` ImageCollection | |
| Directory | `files` FileCollection | |
| Palette | `palette` ColorPalette | `images` ImageCollection, 1 |
| Metadata | `metadata` MetadataCollection | `files` FileCollection or ImageCollection, 1 |
| Comparison | `comparison` ComparisonResult | `sources` FileCollection, ImageCollection or TextContent, 2 |
| Editor | Exported File card | `images` ImageCollection, 1 |
| [Research](source-provenance.md) | `sources` ResearchSources | `sources` FileCollection, ImageCollection or TextContent, 64 |
| [Intelligent](model-context.md) | | `context` ColorPalette, ResearchSources, TabularData or TextContent, 32 |

Drag an output handle to an input handle in Space or use the **Links** form with the keyboard. Archiving a referenced object removes its links from the active graph. Undo restores its original endpoints and link IDs. Copy and Paste preserve internal links among copied nodes with new IDs. An archived link remains in historical snapshots.

## Source reads

Collection reads are scoped to a live link and its target. They return metadata pages of at most 100 entries and a source revision. A caller can pass that revision on the next request. Core returns `SOURCE_CHANGED` if the source changed. Text reads return a bounded literal Note, TXT or Markdown value with a revision. Reads of managed text verify its persisted hash. A Gallery link grants access to the ordered members of its port across all pages.

Gallery imports PNG, JPEG, WebP, WebM and MP4 via the existing transaction and can add media already stored in Space. Its version digest covers the ordered logical asset IDs and immutable versions. Reordering, removal or adding a member creates a new revision. Changes to a separate file card leave its earlier referenced version available. The `files` port contains all members. The `images` port preserves the order of still images and excludes videos. Both scopes use the complete Gallery revision. Palette calculates from the still images and records the count of skipped videos with the result. [Gallery video](file-lifecycle.md#gallery-and-file-video)

### Directory

The Directory output links the project's workspace tree on Windows. It walks regular files in deterministic order by relative path. Forge storage (`.forge` and `assets`) is excluded. Junctions, hard links, unreadable entries and folders beyond 32 levels contribute an unavailable count. The tree is capped at 5,000 entries and up to 2,000 entries in a folder. Ordinary files with an unrecognized extension are listed as Other.

A Directory file identity comes from its relative path within the project. Its version adds the Windows handle fingerprint, including file ID, size, modified time and ChangeTime. Collection cursors are invalidated when the ordered versions or unavailable entries change. Reading pins the ancestor directories and opens the file with shared reading only. It checks the handle before and after bounded copying and records SHA-256 after a successful read. Historical previews also check the recorded digest. The current link, collection revision and selected version identify the source for the read.

## Palette

An active ImageCollection input supplies the images. Calculate accepts 4, 8 or 16 target colors. Empty collections and collections without visible pixels produce a successful empty result. The user can open the aggregate, each image's palette and earlier successful runs.

`forge.palette.srgb-median-cut.v2` converts samples to sRGB. PNG uses color chunks in priority order: SDR RGB `cICP`, embedded `iCCP`, explicit `sRGB`, then legacy `gAMA` and `cHRM`. Range expansion uses the encoded PNG sample depth. Legacy gamma-only files use sRGB primaries, and legacy chromaticities-only files use the sRGB transfer curve. Untagged PNG defaults to sRGB. JPEG and WebP use an embedded ICC profile or the decoder's color space. PQ and HLG PNG require tone mapping and return `COLOR_PROFILE_UNSUPPORTED` in this version. [PNG color chunk precedence](https://www.w3.org/TR/png-3/#color-spaces)

Each image contributes up to 16,384 evenly spaced pixel samples. Color conversion and alpha weighting retain 16-bit samples until quantization of the sRGB swatches. If every regular sample is transparent, a scan checks for a visible pixel. Fully transparent pixels contribute zero. Other pixels contribute in proportion to alpha. Each nonempty image has the same aggregate weight. A bounded RGB histogram and weighted median cut generate swatches with stable tie breaking. Shares are expressed in basis points and sum to 10,000 for nonempty results.

Successful runs store the target ID, source link and port, ordered source revision, exact asset IDs and version IDs, source and result SHA-256 digests, algorithm ID, selected color count and UTC time. The SQLite write publishes the summary and data together. Retrying the same operation with the same request returns the stored result. Cancel before publication discards the in-flight calculation. A cancel or failure keeps any previous success. Results can be marked stale after an input, link or algorithm change. A disconnected or missing source gets an unavailable status with its latest check time. Local result history remains readable from the Palette card without starting a new source read. File palettes page up to 100 items.

Existing v1 Palette results retain their original digest and history. Opening them with v2 marks them stale. A new calculation uses the same inputs and stores a separate v2 result.

## Metadata

Connect the `files` port of a File, Gallery or Directory, or the `images` port of a Gallery or image, to Metadata. **Calculate** verifies readable files and records the source revision, algorithm, UTC calculation time, SHA-256 result digest, and ordered file and version IDs. The file table pages up to 100 rows. Directory files larger than 128 MiB or beyond the run's 512 MiB reading budget are listed with an explanation. Managed text and valid Directory TXT/Markdown up to 256 KiB show their UTF-8 encoding. A damaged Directory image header is reported on its own row.

`forge.metadata.verified-headers.v1` reads image dimensions and selected EXIF fields from verified PNG, JPEG and WebP assets. The EXIF allowlist includes camera make and model, orientation, exposure, aperture, ISO and focal length. Optional EXIF blocks above 256 KiB or with invalid contents appear as unreadable. The file identity and image dimensions remain visible.

EXIF coordinates are hidden by default. **Show EXIF location** requests a fresh verified read of one specifically selected version in the latest current result. Core checks the live link, ordered source revision, result ID and version membership before returning coordinates. The ordinary table and persisted result can indicate coordinate availability. Latitude and longitude remain outside the result, history, and general metadata reads. Source replacement or detachment revokes access via the old result. Older results remain available for the previously calculated file fields. Original managed images retain their original bytes, including embedded EXIF.

## Comparison

Select left and right versions from one connected collection or from two connected sources. Each side pages up to 100 choices. A choice carries the read-only link and source revision. Core checks both revisions and item membership at calculation time. It rejects a duplicate version or note, mixed text and image input, and formats outside the supported pairs.

`forge.comparison.documents-and-pixels.v2` compares notes, TXT, Markdown and extracted document text. It normalizes CRLF to LF and tracks whether the final line has a newline. TXT and Markdown accept up to 256 KiB per file. DOCX and PDF accept up to 8 MiB per file and 64 KiB of extracted text. PDF uses the isolated text worker with the existing time, page and memory limits. DOCX opens `word/document.xml` from the validated package, reads WordprocessingML body paragraphs and table cells in document order, and treats tabs and explicit breaks as text. The extraction skips deleted and moved-from text. Styles, layout, headers, footers and graphics are outside the text result. A document with no extracted text reports an error and preserves prior results. [PDF worker limits](source-provenance.md#local-pdf-text-extraction)

The line aligner uses a deterministic four-million-cell budget and preserves the shared prefix and suffix. If the middle block exceeds the budget, the result identifies that block as removed and added. Diff pages include line numbers and up to 100 rows.

PNG, JPEG and WebP pairs display verified previews side by side. Equal decoded dimensions of up to four million pixels also produce an exact count of changed pixels and a scaled difference mask. A dark pixel marks a change. The comparison uses the decoded RGBA values at each coordinate, compares alpha and ignores RGB where both pixels are fully transparent. Each input has the normal 128 MiB file and 40 megapixel decode limits. Different dimensions and larger images keep the side-by-side view and show why the mask is unavailable.

The result records both exact versions and source links. Opening an image or mask in history requires that the same live links still give access to the recorded inputs. Removing an item or link revokes the corresponding preview and the pair's mask. A changed input revision marks the result stale. Earlier `forge.comparison.lines-and-images.v1` records open with their original line or side-by-side result. Project ZIPs retain analysis summaries and text diffs. The mask is regenerated from the verified image versions on request.

Palette, Metadata and Comparison share immutable run records, operation replay validation, source status, history and the cancellation boundary. Metadata and Comparison recheck the Directory collection before saving. Downstream result ports are declared for the later consumers.

Run `node tests/comparison-formats-desktop.mjs` to verify DOCX and PDF text, an empty PDF failure, exact changed pixels, restore and revoked access.

## Verification

Run the Rust workspace tests and `node tests/gallery-links-desktop.mjs` after building Windows Core and the UI. The fixture uses red PNG, blue JPEG and green WebP samples. It checks mixed import, pagination, source revisions, keyboard and pointer connections, archive and Undo, and restart. Then run `node tests/palette-desktop.mjs` for known swatches and shares, empty and transparent input, stale results, cancellation, provenance, history and restart.

Run `node tests/palette-png-windows.mjs` for PNG color chunk precedence, legacy gamma and chromaticities, limited-range SDR, 16-bit color and alpha, and explicit HDR rejection with previous history retained.

Run `node tests/metadata-desktop.mjs` for a single File and a paged Gallery, synthetic GPS and camera fields, a malformed EXIF block, revocation after replacement, persisted coordinate exclusion and restart.

Run `node tests/comparison-desktop.mjs` for TXT/Markdown with differing line endings, pagination, replacement, historical diffs, a PNG/JPEG pair selected across Gallery pages, mixed input rejection, removed-image revocation and restart.

Run `node tests/directory-source-desktop.mjs` for nested Directory sources, Metadata and Comparison, external edits, concurrent writing, protected storage, link exclusion and preservation of results after reopening.

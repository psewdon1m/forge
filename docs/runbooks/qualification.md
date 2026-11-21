# Windows release qualification

Record the exact Forge commit, Windows build, package SHA-256, source and target versions, provider and document editor versions, and a result or open issue for each applicable check. Run the source checks from the exact clean commit. Run installation, update and recovery through the launcher from the exact signed ZIP. Preserve original fixtures and use separate profiles and projects for normal update, manual rollback, interrupted activation and failed startup.

## Plain checks

| Plain | Starting point | Required result | Windows automation |
| --- | --- | --- | --- |
| Directory | Project tree with allowed and unavailable entries | Browse and mutate allowed paths. Source version changes after an external edit. | `directory-desktop.mjs`, `directory-source-desktop.mjs` |
| Gallery | PNG plus a qualified WebM and MP4 | Preserve mixed order, open a poster and play and seek on the saved versions. | `gallery-links-desktop.mjs`, `gallery-video-desktop.mjs` |
| Scheme | Empty Scheme | Create and link shapes, save and reopen the same graph. | `scheme-desktop.mjs` |
| Checklist | Group and unchecked item | Complete and reopen the same item and history. | `checklist-desktop.mjs` |
| Site | Loopback HTTPS source and test login | Keep sessions isolated and capture a reference and explicit quote. | `site-desktop.mjs` |
| Dataset | CSV or TSV fixture | Validate and import the data with stable row values and queries. | `dataset-desktop.mjs` |
| Research | Linked note, PDF, saved quote or WAV | Cite exact source versions. Preserve citations, transcript timing and original bytes across restore. | `research-desktop.mjs`, `research-transcription-desktop.mjs` |
| Intelligent | Linked project material and local test provider | Review exact input, handle failure and save an approved result. | `intelligent-desktop.mjs` |
| Git | Synthetic Git working tree with a second branch | Review index diffs, commit staged changes, verify clean checkout and preserve conflict files. | `git-desktop.mjs` |
| Editor | Linked version of a known PNG | Render and cancel, save a recipe, export separately and reproduce the exported bytes. | `editor-desktop.mjs` |
| Comparison | Document versions and a matching-size image pair | Compare exact selected versions and restore the saved result. | `comparison-desktop.mjs`, `comparison-formats-desktop.mjs` |
| Metadata | Image with metadata and a known file hash | Inspect the exact file version and reveal coordinates only from a current result on request. | `metadata-desktop.mjs` |
| Palette | Gallery with known colors and videos | Match the known image colors, report skipped videos and keep prior results on cancel. | `palette-desktop.mjs`, `gallery-video-desktop.mjs` |

Run the scripts from the Forge root with `node tests/SCRIPT` after building the Windows Core and renderer. The Verify workflow runs the matrix and the source, security, backup, startup and release gates. [Verify workflow](../../.github/workflows/verify.yml)

## Four projects

1. **Prepare a shoot.** Import reference images with known colors and a test video. Open Gallery, prove playback, and connect its images to Palette and its files to Metadata. Review the result in Intelligent. Replace an image, cancel one recalculation and complete the next. Record the prior and new source revisions and the Palette skip count. Restore the project ZIP in a fresh profile. Compare the Gallery order, stored hashes and result history. Open a Site card and check the new profile. Use `shooting-project-windows.mjs` for the packaged shooting flow.
2. **Compare monitors.** Use a loopback HTTPS fixture with test credentials, and a CSV with three named models and evaluation criteria. Capture and approve a quote from Site into Research. Import the CSV into Dataset. Link both sources to Intelligent, review their versions and save a result with the local provider. Unavailable networking must leave the saved quote and result readable. Restart and restore the project copy. Compare the quote bytes, rows and saved model context.
3. **Prepare for an exam.** Import a PDF with a known text layer and Markdown notes. Create a Checklist of topics. Cite both files in Research, then replace one file and find the stale source indication. With networking unavailable, read the saved excerpt and complete a checklist item. Restart and restore the project copy. Compare citations, captured source versions and checklist state.
4. **Develop software.** Choose a synthetic Git working tree. Review an unstaged change, stage it and commit with a fixture author. Review another branch, and verify that a dirty or conflicted working tree blocks switching and preserves the original bytes. Save a Scheme and a Comparison of two versions of a document. Restore the ZIP into a separate profile and confirm the Scheme and Comparison result, then explicitly bind the Git card and confirm HEAD and status. Check Editor with the reference recipe.

## Release-host checks

- Use an isolated standard-user account with no existing Forge installation on supported Windows 11 x64. Authenticate the launcher and verify the release manifest and exact ZIP. Compare installed hashes and record the active version.
- With a supported predecessor and a project containing the oldest and newest supported file versions, save a backup, update in Settings, then reopen the same project. Verify the startup result, project database, attachments and settings. Restart once more.
- Exercise manual rollback with the correct archive and with a missing or invalid archive. Exercise automatic rollback with a startup failure and activation interruption on the isolated qualification channel. Confirm the previous slot and project data after each recovery.
- Run `node tests/release-windows.mjs --committed --updates --manual-rollback --slow-readiness` with the isolated test packages. It delays readiness for the successor by 15 seconds and for the previous version by 20 seconds. Confirm that the active slot is unchanged while each proof is pending, both startups complete within the budget, and rollback restores the project and settings.
- Repeat the DOCX and PDF checks with registered Windows handlers on the release host. The matrix records the expected preservation and editor limitations. [Document editor matrix](../contracts/document-editor-matrix.md)
- Managed video requires a Core that supports the video types in the project. Verify media compatibility on both slots before qualifying a rollback path. Git bindings are per device, and a restored copy needs an explicit rebind. [File lifecycle](../contracts/file-lifecycle.md) · [Git Plain](../contracts/git-plain.md)
- Follow public release candidate checks, signing and promotion for the exact artifact. [Release guide](release.md) · [Recovery guide](recovery.md)

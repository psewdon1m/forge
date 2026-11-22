# Desktop dependencies and data boundaries

The checked-in npm and Cargo lockfiles constrain development builds. The Windows host uses Node.js 24.14.0, npm 11.9.0 and Rust 1.94.1. The alternative Windows development build uses the Rust image digest recorded in the developer Dockerfile. The release pipeline will have its own native Windows qualification.

| Dependency | Locked release | License | Use |
| --- | --- | --- | --- |
| Electron | 45.4.1 | MIT, with separate Chromium and bundled third-party notices | Windows shell, local renderer and isolated Site process |
| React / React DOM | 19.3.1 | MIT | Application UI |
| React Flow | 12.12.1 | MIT | Space and Scheme geometry and interaction |
| Lucide React | 1.77.0 | ISC as declared by package, with bundled notices | Interface icons |
| Space Grotesk Variable / IBM Plex Mono | 5.3.0 wrappers | OFL-1.1 | Locally packaged fonts |
| TypeScript / Vite | 6.0.3 / 8.3.8 | Apache-2.0 / MIT | Type checking and local UI build |
| Playwright test | 1.65.1 | Apache-2.0 | Development qualification |
| rusqlite / libsqlite3-sys | 0.43.0 / 0.40.0 | MIT | Local project transactions and reads |
| Bundled SQLite | 3.54.1 | Public domain | Project database engine |
| git2 / bundled libgit2 | 0.21.0 / 1.9.7 | MIT OR Apache-2.0 for the bindings, GPL-2.0 with the libgit2 linking exception for the native library | Local Git reads and writes. HTTP, SSH and credential features are disabled. [Native license](https://github.com/libgit2/libgit2/blob/v1.9.7/COPYING) |
| cap-std / cap-fs-ext | 4.0.3 | Apache-2.0 with LLVM exception, Apache-2.0 or MIT | Capability handles for project staging and asset storage |
| image | 0.25.10 | MIT OR Apache-2.0 | Bounded PNG, JPEG and WebP validation |
| kamadak-exif | 0.6.2 | BSD-2-Clause | Parse bounded EXIF blocks for Metadata |
| lopdf | 0.47.0 | MIT | Read local PDF text layers in a separate constrained Core worker. Default features are disabled. |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 | ICC conversion to sRGB for Palette |
| png | 0.18.1 | MIT OR Apache-2.0 | Inspect PNG color chunks for Palette using the same pinned codec as image |
| zip / quick-xml | 9.8.1 / 0.42.0 | MIT | Bounded DOCX package and XML validation |
| serde / serde_json | 1.0.228 / 1.0.149 | MIT OR Apache-2.0 | Project data and protocol |
| url | 2.5.9 | MIT OR Apache-2.0 | Canonical HTTPS reference validation in Core, with IDNA and ICU data pinned in Cargo.lock |
| ed25519-dalek / semver | 2.2.0 / 1.0.27 | BSD-3-Clause / MIT OR Apache-2.0 | Native release signature verification and ordering of signed Stable versions |
| ureq / rustls | 3.5.2 / 0.23.46 | MIT OR Apache-2.0 / Apache-2.0 OR ISC OR MIT | Bounded HTTPS in the update helper, with WebPKI roots and locked TLS dependencies |
| httpdate | 1.0.3 | MIT OR Apache-2.0 | Parse the standard HTTP-date form of Retry-After in the native updater |
| sha2 / uuid | 0.10.9 / 1.23.0 | MIT OR Apache-2.0 | Revision digests and stable identities |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | Windows COM and Shell bindings and Job Object limits for the PDF worker |

The build downloads dependencies from the pinned registries. Run the recorded license and provenance checks, including transitive dependencies and Electron notices, against the final distributable. Supplied image rights require qualification before public distribution. [SQLite 3.54.1 release notes](https://sqlite.org/releaselog/3_54_1.html)

## Data recipients

| Recipient | Data and isolation |
| --- | --- |
| Forge Core | Explicitly opened project folder, active project operations, local SQLite. No external connectivity is needed. |
| PDF text worker | The verified bytes of a single linked PDF over a private pipe. Its text response is capped and the worker exits after the request. |
| Trusted main process | OS folder picker and recent-project locations. The renderer gets titles and IDs for the recent list. |
| Local app renderer | Canonical project data delivered by the checked preload. Bundled UI assets and fonts load locally. |
| Selected Windows viewer or editor | Explicitly opened, verified copy of the selected asset. The editor receives its writable copy under Forge app data. |
| Site WebContents | Browser origin and profile data within a segregated context. Its qualification certificate exception targets a per-run loopback fixture. |
| Release service | Future package/index fetches and corresponding metadata. |
| Optional local Ollama server | Installed model ID during capability checks. The exact user-approved request and material text are sent after review to loopback port 11434. [Context and provider contract](model-context.md) |
| Optional local whisper.cpp server | Exact approved PCM WAV bytes and transcription options over IPv4 loopback port 8080. The file is sent under a fixed name. [Automatic transcription contract](source-provenance.md#automatic-transcription) |

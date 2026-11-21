# F00 platform qualification

Status: in progress. Target profile Windows 11 x64 and one per-user desktop application. The authoritative repository is `https://github.com/psewdon1m/forge.git` with default branch `main`.

| Area | Result on development host | Outstanding qualification |
| --- | --- | --- |
| PowerShell/Node | Node 24.14.0, npm 11.9.0, exact npm dependency lock | Repeat setup and smoke on a clean VM |
| Electron candidate | Electron 45.4.1 and Chromium 156.0.8078.100. The HTTPS fixture proved isolated Site code, redirect into a session, persistence, a separate partition, popup interception and download interception | Verify navigation and login on representative allowed production sites. Validate allowed popup and controlled download workflows in F05 |
| Tauri candidate | Native Rust and MSVC tools absent from the development host. Tauri prototype remains unmeasured | Run on a qualified Windows toolchain. Compare the embedded Site and canvas using the same scenarios |
| Space input and rendering | Local development evidence passed an offscreen Electron 500‑object, 1,000‑link benchmark. Three cold starts under 0.5 s and p95 frame intervals under 17 ms | Repeat in the reference Windows VM with actual foreground rendering, pan and drag |
| UI profile | Project / Space / Portal in a light monochrome desktop prototype | Confirm responsive and keyboard matrix, record the Part 00 visual variation |
| Rust Core | Rust 1.94.1 / SQLite in digest-pinned Linux tooling, 4 local persistence tests | Native Windows tests, multi-window/close lifecycle and UI round trip |
| Release trust | Repository identity and public read access verified | Write access, protected environment, signing trust and qualified release checks |

The hidden-window frame result collected before enabling offscreen rendering was discarded for performance acceptance. It measured Chromium's hidden-window throttling. Neither local measurement represents a clean Windows VM or a released installer.

The development host reports Windows Sandbox and the full Hyper-V role disabled. The running compute service for WSL/Docker does not provide a clean desktop Windows VM. A reference Windows VM is still required for the comparative run.

Sources: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [Tauri Webview API](https://v2.tauri.app/reference/javascript/api/namespacewebview/), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

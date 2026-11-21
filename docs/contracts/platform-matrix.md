# F00 platform qualification

Status: in progress. Target profile Windows 11 x64 and one per-user desktop application. The authoritative repository is `https://github.com/psewdon1m/forge.git` with default branch `main`.

| Area | Result on development host | Outstanding qualification |
| --- | --- | --- |
| PowerShell/Node | Node 24.14.0, npm 11.9.0, exact npm dependency lock | Repeat setup and smoke on a clean VM |
| Electron candidate | Installed Forge `ac1311a` uses Electron 45.4.1 and Chromium 156.0.8078.100. Shared HTTPS fixtures confirmed Site isolation, approved sign-in and dismissed popup requests, session and sign-out across restart, HTTP redirect rejection and the 32 MiB download policy | Repeat on the reference VM. Verify navigation, sign-in and sign-out on an approved external domain with an authorized account |
| Tauri candidate | Tauri 2.12.7 on Windows GNU with WebView2 Fixed Runtime 158 reproduced the local popup, profile and sign-out checks. The first redirect test reached the HTTP listener. Three repeats with native request interception blocked it before network access. In two earlier download runs WebView2 reported 24 bytes for a response without `Content-Length` and the prototype saved it | Qualify Windows MSVC and the embedded API, account for the missing-length discrepancy, and repeat with the approved external account |
| Space input and rendering | The installed Electron candidate opened the foreground 500-object, 1,000-link project in 200.4–301.9 ms in three development-host runs with 4 CPU and 16 GiB limits. The p95 frame interval was 16.9 ms | Repeat setup, verify and foreground Space input on the reference VM |
| UI profile | Project / Space / Portal in a light monochrome desktop prototype | Confirm responsive and keyboard matrix, record the Part 00 visual variation |
| Rust Core | Rust 1.94.1 / SQLite in digest-pinned Linux tooling, 4 local persistence tests | Native Windows tests, multi-window/close lifecycle and UI round trip |
| Release trust | Repository identity and public read access verified | Write access, protected environment, signing trust and qualified release checks |

The hidden-window frame result measured Chromium's hidden-window throttling and was discarded. The foreground result covers the installed local candidate on the development host.

The development host reports Windows Sandbox and the full Hyper-V role disabled. The running compute service for WSL/Docker does not provide a clean desktop Windows VM. A reference Windows VM is still required for the comparative run.

Sources: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [Tauri Webview API](https://v2.tauri.app/reference/javascript/api/namespacewebview/), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

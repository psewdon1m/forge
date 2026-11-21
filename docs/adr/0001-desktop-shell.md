# ADR 0001 — Desktop shell qualification

Electron is the working candidate. F00 qualification is open.

Forge preserves a standalone Rust process with a bounded command protocol. The UI renders from local files and the privileged application preload is scoped to the application window. Site uses a separate WebContentsView without that preload, its own profile and a deny-by-default permissions policy. The development qualification mode runs against an ephemeral loopback TLS fixture. Its certificate exception is limited to the fixture certificate fingerprint and host.

On the development host, the installed Forge candidate at `ac1311a` ran against the same local HTTPS fixture as a standalone Tauri 2.12.7 prototype. The prototype was built for Windows GNU and used WebView2 Fixed Runtime 158 with the unstable child WebView API. Three complete runs reproduced session persistence and isolation, unapproved popup denial, cancellation of direct HTTP navigation, and the 32 MiB download checks. Forge saved the 12-byte attachment after explicit approval.

Two earlier runs exposed a difference in the native Tauri adapter. WebView2 reported a size of 24 bytes for a response without a `Content-Length` header and the prototype saved it. The later runs reported zero and the adapter refused it. Windows MSVC and the supported API path remain to be qualified. The installed Electron candidate refused the same chunked response in all four observed Electron runs.

The shared session fixture also passed approved and dismissed sign-in requests, nested popup denial, profile inheritance, and sign-out across restart. In the initial Tauri run, the navigation callback canceled the transition and the separate HTTP listener received the redirected request. A native WebView2 request filter supplied a local response before the wire request in three repeats. The listener saw zero requests from either shell in those repeats. [WebView2 navigation cancellation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2navigationstartingeventargs?view=webview2-1.0.3967.48) · [WebView2 request filters](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webresourcerequested).

The final shell choice requires foreground Space measurements on the reference Windows profile and Site sign-in and sign-out on the approved external domain. [Qualification matrix](../contracts/platform-matrix.md)

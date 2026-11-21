# ADR 0001 — Desktop shell qualification

Status: Electron is the working candidate. F00 comparison is open.

Forge preserves a standalone Rust process with a bounded command protocol. The UI renders from local files and the privileged application preload is scoped to the application window. Site uses a separate WebContentsView without that preload, its own profile and a deny-by-default permissions policy. The development qualification mode runs against an ephemeral loopback TLS fixture. Its certificate exception is limited to the fixture certificate fingerprint and host.

The Electron candidate started successfully on Windows 11 and passed the local Site and Project tests. The development host has no native Tauri build toolchain. Linux-hosted cross-compilation successfully produced the isolated Rust Core developer executable. It does not establish a Windows Tauri result or serve as a production toolchain.

Complete the comparison on a clean reference VM, including the Site cases in the production plan. Record the final shell choice with the foreground performance and compatibility evidence. [Qualification matrix](../contracts/platform-matrix.md)

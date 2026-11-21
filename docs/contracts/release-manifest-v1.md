# Forge release manifest v1

The Windows x64 Stable client accepts a versioned manifest and a separate Ed25519 signature. The public trust anchor is compiled into the first-install executable. Manifest parsing, key selection, compatibility, file size and SHA-256 checks run in the native launcher and helper.

```json
{
  "artifact": {
    "bytes": 171199452,
    "sha256": "3d12ac4b6a7f7040649531983c4de6a9ca2536a46492136e1dc98fe410a23bdf",
    "url": "https://github.com/psewdon1m/forge/releases/download/forge-v0.0.1/forge-0.0.1-windows-x64.zip"
  },
  "channel": "stable",
  "commitSha": "f5eeda81cd66e16af8585bad3ce7fe2ead706525",
  "compatibility": {
    "helperMax": "0.0.1",
    "helperMin": "0.0.1",
    "minimumWindowsBuild": 22000,
    "projectSchemaMax": 1,
    "projectSchemaMin": 1
  },
  "dataPolicy": "no-migration-v1",
  "platform": "windows-x64",
  "product": "forge",
  "releaseNotes": "Notes for the selected release.",
  "schemaVersion": 1,
  "tag": "forge-v0.0.1",
  "version": "0.0.1"
}
```

The example uses development fixture data and is formatted for readability. `forge-release.json` stores the canonical compact UTF-8 object. Property names are sorted in every object, using ASCII case-sensitive comparison. The schema uses fixed ASCII property names, strings and nonnegative integers. It accepts no duplicate or unknown properties. The signed byte string is the ASCII sequence `forge.release.v1`, one zero byte and the canonical JSON bytes. `forge-release.sig` is exactly 64 raw bytes. The native verifier checks canonical encoding and strictly verifies the detached signature. [Canonical JSON](https://www.rfc-editor.org/rfc/rfc8785.html) · [Ed25519 strict verification](https://docs.rs/ed25519-dalek/2.2.0/ed25519_dalek/struct.VerifyingKey.html#method.verify_strict).

| Input | Acceptance |
| --- | --- |
| Version and tag | Stable SemVer without a prerelease or build suffix. Tag is exactly `forge-v<version>`. Commit is a full lowercase 40-hex Git SHA. CI independently matches the qualified tag, its peeled commit and current remote `main`. |
| Artifact URL | Exactly the versioned Forge repository URL in the example, with tag and filename derived from the manifest version. Query and fragment are excluded. |
| Size and digest | 1 byte through 512 MiB of ZIP bytes. SHA-256 is 64 lowercase hex characters. Native verification holds the package open with write and delete sharing disabled during verification and extraction on Windows. |
| Compatibility | Windows build at least 22000 and at least the signed minimum. Helper version and project schema must fall within the inclusive ranges. The bootstrap also rejects versions older than its own release. |
| Data policy | `no-migration-v1` declares that the release preserves the current settings and project schemas. The field is required for preparation through Settings. Earlier signed records without this field remain valid for first install and discovery. |
| Notes and metadata | Notes are bounded plain text up to 16 KiB. The canonical manifest and transition each have a 64 KiB input limit. |

The updater compatibility version is recorded in [helper-version.txt](../../crates/forge-update-helper/helper-version.txt). The Rust updater and the manifest builder read the same value. The bootstrap separately uses its own release version as the minimum for a first install. A qualification client can use an earlier desktop release number while running a supported updater version.

## Rotation

The current key signs a separate JSON record with `product`, `schemaVersion`, `channel`, `nextPublicKey`, `useNextFrom` and `retirePreviousAt`. `nextPublicKey` is the 32-byte public key in lowercase hex. The domain prefix is `forge.release-key-transition.v1` followed by a zero byte and the compact canonical record. An existing anchor must authenticate the transition. The version at `useNextFrom` accepts either key. `retirePreviousAt` is the next patch in that major/minor series, after which only the next key can verify a release. Before `useNextFrom` only the current key is valid. A first install can retain the verified transition with its slot and recheck it during launch. Carrying an accepted transition across later update jobs and recovering trust state is part of the updater.

## Local installation

The install root is `%LOCALAPPDATA%\Forge\Installation`. A dedicated lock serializes first installs. The installer verifies the ZIP, extracts only bounded regular-file entries into an owned staging directory and checks the embedded commit, app version, Electron runtime version and x64 executable headers. Package paths reject absolute paths, aliases, reparse entries and Windows device names. The installer commits the staged slot before atomically publishing `active.json`. Restarting after interruption can leave an inactive slot; the launcher uses only the slot named by the validated active record. A second first-install command leaves the active version in place.

The installed launcher reads that record, authenticates the slot's saved release manifest and starts `Forge.exe`. Runtime files live in `Installation\slots`; the per-user Electron profile lives separately in `%LOCALAPPDATA%\Forge\Profile`. Launch reads the installed files and has no network dependency. Windows must qualify the exact setup and runtime files before public distribution. The current development proof uses Electron 45.4.1 and a one-run test signing key. [Electron application packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution).

# Stable update discovery

**Settings → Updates** shows the installed version and availability of the native helper. It reads the active slot locally when opened. **Check for updates** starts a fresh metadata check. Creating or reopening a project does not initiate an update request. Development and unmanaged binaries report that a managed installation is required.

The app uses the already installed helper from the active slot. IPC carries a fixed command and returns status, version and safe display text. The renderer cannot direct the helper to a user-supplied feed or provide a manifest, key, URL or installed digest. The helper verifies the current slot through the launcher's trusted manifest and loads any authenticated transition retained with that slot. The check does not download the package.

## Stable source and trust

- The only production listing is the public GitHub Releases API for `psewdon1m/forge`. The helper uses unauthenticated HTTPS with cache-revalidation headers and reads at most four pages of 100 releases. It reports an error if the listing reaches the bound without showing its end. [List releases API](https://docs.github.com/en/rest/releases/releases?apiVersion=2026-03-10#list-releases).
- Eligible releases are published and immutable, with an exact Forge Stable SemVer tag. Drafts, prereleases and other tags are skipped. Versions are sorted numerically across pages. Duplicate eligible versions or missing, unready or duplicate assets yield an error.
- Manifest, signature and optional rotation records have version-derived URLs. The helper ignores the download URLs returned in the listing. One HTTPS redirect is permitted for assets, restricted to the GitHub release-asset CDN. Metadata is bounded and canonical. The signature and any transition must authenticate against the installed anchor. [Release manifest](release-manifest-v1.md).
- An equal version with a matching package digest is **Up to date**. A lower version or an equal version with different bytes is an error. A compatible newer version shows **Update available** and signed release notes. A verified newer version outside the compatibility range shows **Incompatible**. An unreachable host or refused connection shows **Offline**. DNS failure, TLS verification failure, timeout, a malformed listing and failed authentication have separate error codes and messages. HTTP errors give the numeric status and an approved endpoint host. Response bodies, complete URLs and transport exception text are excluded.

GitHub marks eligible release objects with `immutable: true`. The release operator must enable immutable publication as part of the public channel qualification. The channel can be empty before the first public release. Checks surface that case without offering an update.

Forge retries release-asset GETs on HTTP 502, 503 and 504 for up to three attempts. Each retry starts at the original asset address and verifies any redirect again. Exponential backoff includes jitter and respects both forms of Retry-After within the shared request deadline. The release index uses a single attempt.

## Qualification

Run `node tests/release-windows.mjs --updates` from a Windows checkout after building Core and the UI. Add `--docker` on the development host using the cross-build container. The test builds a separate helper with the `qualification-discovery` feature and a test key. Only that build accepts an explicitly configured HTTPS loopback fixture and its ephemeral CA. The protected candidate workflow builds without this feature and rejects the fixture test mode. **Check for updates** uses the same listing, selection and signature validation code in both builds.

At startup the fixture receives zero requests. The Windows harness exercises **Checking**, **Up to date**, **Update available**, **Incompatible**, **Offline**, missing release, invalid signature, same-version digest conflict and forbidden redirect. It also checks HTTP 401, 404 and 503, timeout and malformed metadata without fetching the package. See [update preparation](update-staging-v1.md) for the Settings confirmation and download flow.

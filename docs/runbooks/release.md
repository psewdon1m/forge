# Building and qualifying a Forge release

## Operator context

Before building, publishing or recovering, record the host and checkout or delivery directory, current revision or release tag, and the target paths in the local operations record. Check those values before running a command that changes a tag, a release, the active installation or project state. Public evidence should use the role of the host and the verified release identifiers. Keep private hostnames and user paths in the local record.

| Operation | Host and working directory | Context to verify |
| --- | --- | --- |
| Source checks and dispatch | Windows development host, Forge checkout root | Clean checkout, matching manifest version, `psewdon1m/forge` origin and exact qualified tag |
| Draft publication | Release operator host, extracted verified signed delivery | Matching signing run ID, commit, tag and staged inventory before uploading |
| External verification and install | Clean Windows host, separate directory containing the independently downloaded delivery | Windows build, standard user profile, immutable release ID, package and setup digests |
| Recovery | Affected Windows user account, authenticated installed launcher | Active version and slot, current update job and hash of the selected recovery ZIP |

Use the release and recovery procedures below for repeat operations. If an incident needs a temporary workaround, record its issue or incident ID and removal condition in the operations record. Update the corresponding runbook and retire the workaround when the corrected release is qualified.

## Local candidate

Use the pinned Windows x64 toolchain and run the desktop tests before preparing a delivery. Local qualification does not require a GitHub signing key.

```powershell
./scripts/setup.ps1
cargo build --locked --release -p forge-core
New-Item -ItemType Directory -Path '.local/bin' -Force | Out-Null
Copy-Item -LiteralPath 'target/release/forge-core.exe' -Destination '.local/bin/forge-core.exe'
./scripts/verify.ps1 -Suite All
./scripts/package.ps1 -Channel candidate
```

On the Windows development host with Docker instead of a native toolchain, run `./scripts/package.ps1 -Channel candidate -Docker` after setup. This builds Core, the renderer and the test-signed delivery. The fixture and observations are under `.local/qualification/release-*/`. Its key is generated in memory for one run and its local composite revision is synthetic. The qualified GitHub workflow supplies the pinned public trust anchor and its artifact output directory to the same command.

For the candidate-as-update-target rehearsal, run `node tests/release-windows.mjs --updates --candidate-target --manual-rollback`. Add `--docker` on the cross-build host. The harness packages the current release with the normal updater features and an ephemeral test anchor. It uses the same signed ZIP for first install and for an update from a separately compiled synthetic `0.0.0`. The test predecessor alone can select the isolated HTTPS service. The harness compares the installed manifest, signature, launcher-facing runtime files and exact package SHA-256. It also checks rejection of the wrong signed channel and verifies rollback and the project database. Use the ordinary `--updates` scenarios to exercise the current release as the source of an update.

The delivery includes the Windows ZIP, versioned setup executable, CycloneDX inventory, in-toto build statement, notes and SHA256SUMS. Electron and Chromium notices travel inside the ZIP. The ZIP also includes the Git bindings, libgit2 and zlib notices under `notices/git`. Review the corresponding source availability for bundled libraries before public distribution. The build statement records the commit, build-run identity, inputs and output digests. Its JSON attestation is build evidence. The detached signature independently authenticates the versioned manifest and its exact artifact.

## Qualified GitHub workflow

Run `./scripts/pre-push.ps1 -Base <base-sha> -Head <outgoing-sha>` from a clean checkout. Use `-Base root` for the initial commit and `-Docker` on the Windows cross-build host. Record the measured automated results alongside the seven-area review for the exact outgoing range.

1. Review the outgoing diff and record the seven Part 06 areas for the exact revision. Protect `main` and qualified tags. Configure the repository variable `FORGE_RELEASE_PUBLIC_KEY_HEX` with the Ed25519 public anchor. Configure the `forge-release-signing` environment with reviewer protection, qualified tag restrictions and the protected `FORGE_RELEASE_SIGNING_KEY` PKCS#8 PEM. The protected step passes the PEM through standard input to the signer with the secret excluded from the signer process environment. [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
2. Confirm the version in `package.json`, both lockfiles, the workspace manifest, and release notes. Create `forge-v<version>` at the intended remote `main` commit. Run `node scripts/qualified-release-ref.mjs refs/tags/forge-v<version>` after pushing the checked tag to verify the remote and checkout. Plain `v<version>` tags run verification only.
3. The qualified tag builds the ZIP once. The unprivileged Windows job verifies those bytes with a disposable test key and launcher. The candidate launcher and ZIP keep the production public anchor. Save the successful candidate run ID and SHA-256. Confirm rights for the distributed files and retain the licence evidence.
4. Draft `known-problems-report.json` from the candidate's unsigned manifest. Review every active ID from the pinned catalog. Record verifiable evidence for PASS. For N/A, record the verified profile, relevant components and reason. Set REL-06 to `UNKNOWN` with `deferred_until` set to `signed-artifact`. Set REL-09 and TRUST-03 to `UNKNOWN` with `deferred_until` set to `release-ready`. For each deferred row, give the reason and a public reference to the verification procedure. The gate requires these three checks at their documented stages and blocks any other `UNKNOWN` or any `FAIL`. Keep only public evidence references in the report because it travels through a workflow input and into the release bundle.
5. Dispatch **Record Forge candidate review** on the same qualified tag with the reviewed report and candidate run ID. Wait for a successful run with the `forge-known-problems-review` artifact. This read-only workflow validates the exact ZIP, provenance, smoke results and Part 12 pre-signing report.
6. Dispatch **Prepare signed Forge release** on the same tag with the successful candidate and review run IDs. Its read-only gate checks the successful Verify workflow for the exact `main` commit. The protected signer redownloads the approved bytes, matches the key to the embedded anchor and creates the signed delivery. A separate read-only job verifies the detached signature, the approved bytes and the exact asset inventory with the public anchor. It records REL-06 as PASS in `signed-phase-report.json` and uploads it with `signed-verification.json` in `forge-signed-release-review`. Wait for the successful run and download `forge-staged-signed-delivery` from that run.

Run the report commands from the checked release revision, with the downloaded candidate in `candidate/`. The draft contains `UNKNOWN` for every entry so it can be opened and filled before dispatch.

```powershell
node scripts/release-policy.mjs draft candidate/forge-release.unsigned.json |
  Set-Content -Encoding utf8 known-problems-report.json
$candidateRun = Read-Host 'Successful candidate run ID'
gh workflow run release-review.yml --repo psewdon1m/forge --ref forge-v0.0.1 `
  --raw-field "candidate_run_id=$candidateRun" --field "report=@known-problems-report.json"
```

Submit the last command after the report review. The workflow dispatch field has the GitHub payload limit, so link to evidence rather than embedding logs. [GitHub Actions dispatch inputs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#defining-inputs-for-manually-triggered-workflows) · [GitHub CLI workflow run](https://cli.github.com/manual/gh_workflow_run).

The first public release also requires F08 acceptance and an independently authenticated first-install executable. Enable GitHub immutable releases before publishing. Retain the exact previous signed bundle and its evidence for the supported rollback window and record the expiry before promotion.

## External verification and Stable promotion

Create a GitHub draft from the exact staged signed delivery. Run these commands from the extracted `forge-staged-signed-delivery` directory. The manifest, signature, bootstrap and ZIP come from the same approved build.

```powershell
$tag = 'forge-v0.0.1'
$assets = @(
  'Forge-Setup-0.0.1.exe', 'forge-0.0.1-windows-x64.zip',
  'forge-release.json', 'forge-release.sig', 'forge-sbom.cdx.json',
  'forge-build-provenance.json', 'forge-package-smoke.json',
  'known-problems-report.json', 'release-notes.md', 'SHA256SUMS'
)
gh release create $tag @assets --repo psewdon1m/forge --verify-tag --draft --prerelease --notes-file release-notes.md
```

Confirm the draft's assets and their SHA-256 against the staged delivery before publication. Publish the draft with the prerelease flag still set. GitHub locks the assets and tag upon immutable publication. Forge Stable skips prereleases, so the exact published files can be checked anonymously before operators promote them. [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

```powershell
gh release edit $tag --repo psewdon1m/forge --draft=false --prerelease
```

On a clean Windows 11 x64 host, use PowerShell 7 from a standard user account. Use `signed-verification.json` downloaded separately from the successful signing run to establish the expected file hashes, tag and commit. Download the files anonymously from their versioned release URLs. Authenticate the setup executable before running it. Start in an empty download directory with `signed-verification.json` copied from Actions, and set `$tag` and `$assets` as in the draft step. Use an authenticated GitHub CLI that supports `gh release verify` and `gh release verify-asset`. [GitHub CLI asset verification](https://cli.github.com/manual/gh_release_verify-asset).

```powershell
$repo = 'psewdon1m/forge'
$review = Get-Content -Raw -LiteralPath signed-verification.json | ConvertFrom-Json -AsHashtable
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/tags/$tag"
$commit = Invoke-RestMethod "https://api.github.com/repos/$repo/commits/$tag"
if ($review.tag -cne $tag -or $release.tag_name -cne $tag -or $release.draft -or
    !$release.prerelease -or $release.immutable -ne $true -or $commit.sha -cne $review.revision) {
  throw 'Forge must be public, immutable and pre-release during external verification.'
}
if (Compare-Object $assets $review.checkedFiles.Keys -CaseSensitive) {
  throw 'Approved assets differ from the runbook inventory.'
}
if (Compare-Object $assets ($release.assets | Where-Object state -eq 'uploaded' | Select-Object -ExpandProperty name) -CaseSensitive) {
  throw 'Uploaded release assets differ from the approved inventory.'
}
foreach ($asset in $assets) {
  Invoke-WebRequest "https://github.com/$repo/releases/download/$tag/$asset" -OutFile $asset
  $download = Get-Item -LiteralPath $asset
  if ($download.Length -ne $review.fileSizes[$asset] -or
      (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant() -cne $review.checkedFiles[$asset]) {
    throw "The downloaded asset differs from the signed delivery: $asset"
  }
}
$setup = $assets[0]
gh release verify $tag --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'Release attestation verification failed.' }
gh release verify-asset $tag $setup --repo $repo
if ($LASTEXITCODE -ne 0) { throw 'The attestation does not authenticate this setup executable.' }
```

Install using [the first-install command](#first-installation-and-stopping-a-release). Record the exact Windows build, runtime observations, and the configured DOCX and PDF editors with their open, edit and import results. Check that this installation starts and opens a project offline. Use **Check for updates** and record that the public Stable channel skips this prerelease.

On the same clean VM, qualify the F07 lifecycle on the exact checked-out revision with the isolated test-signed deliveries. Use the candidate-target scenario for a successful Settings update from the test predecessor to the target version using the same local package as first install, then restore the original project from its backup and check manual rollback. Test automatic rollback and interruption using the matching disposable successor fixtures. To use the cross-build toolchain, run `./scripts/build-core-windows-dev.ps1` in place of the native Core build and copy, and add `--docker` to the Node commands.

```powershell
./scripts/setup.ps1
cargo build --locked --release -p forge-core
New-Item -ItemType Directory -Path '.local/bin' -Force | Out-Null
Copy-Item -LiteralPath 'target/release/forge-core.exe' -Destination '.local/bin/forge-core.exe'
node tests/release-windows.mjs --committed --updates --candidate-target --manual-rollback
node tests/release-windows.mjs --committed --updates --failed-startup
node tests/release-windows.mjs --committed --updates --interrupted-startup
node tests/release-windows.mjs --committed --updates --manual-rollback --rollback-crashes
```

Require exit code 0 for each run. Retain each `observations.json` and relevant logs under `.local/qualification/release-*/`. Label the production-signed delivery results and isolated test-signed lifecycle results in the evidence. For later releases, also exercise the upgrade from the oldest supported published source version before Stable. Retain the original ZIP for recovery and record the tested retention window separately.

Create `windows-qualification.json` only after those checks pass. Set `schemaVersion` to `1`, `profile` to `clean-standard-user` and `platform` to `windows-x64`. Set `windowsBuild` to the integer build reported by Windows and `releaseId` to the numeric public GitHub release ID. Copy `tag`, `revision`, `packageSha256` and `setupSha256` from `signed-verification.json`. Give each `checks` entry an object with `status` set to `PASS` and `evidence` set to a public HTTPS reference without credentials or a query string.

| `checks` key | Evidence to retain |
| --- | --- |
| `verifiedFirstInstall` | Public installer attestation, exact delivery hashes and installed version |
| `offlineLaunchAndProject` | Offline launch and project opening from the authenticated installation |
| `stableIgnoresPrerelease` | Fresh native Stable query before promotion |
| `compatibleUpdateFromSettings` | Settings update from the compatible predecessor and observed healthy activation |
| `backupAndRestore` | Backup ZIP and project state verified during recovery |
| `automaticRollback` | Failed startup followed by automatic recovery of the previous version and project |
| `interruptedActivationRecovery` | Restart and recovery after interruption during activation |
| `manualRollback` | Settings rollback to the prior version with the original backup |
| `interruptedRollbackRecovery` | Recovery after interruption during manual rollback |
| `registeredDocxAndPdfEditors` | Both editor workflows and the installed editor names and versions |

Start the final Part 12 report from `signed-phase-report.json`. For REL-09 and TRUST-03, record the external evidence, change the status to `PASS` and remove `deferred_until`. Preserve the previously reviewed rows. Dispatch **Promote qualified Forge release to Stable** with this report, the clean Windows receipt and the successful signing run ID.

```powershell
$signedRun = Read-Host 'Successful signing and independent verification run ID'
gh workflow run promote-release.yml --repo psewdon1m/forge --ref $tag `
  --raw-field "signed_run_id=$signedRun" --field "report=@known-problems-report.json" `
  --field "windows_qualification=@windows-qualification.json"
```

The read-only qualification job repeats the anonymous download checks and GitHub attestation verification. It binds the final report and the Windows receipt to the immutable release ID, signing run and file hashes. After qualification, a separate job promotes that release, verifies public Stable metadata and links the retained report and its SHA-256 in the release notes. If publication succeeded and a job failed during its final check, rerun the failed promotion job on the same run. It accepts an already-promoted release only when the notes contain that exact approval.

Save `forge-stable-qualification` outside Actions before its 90-day retention expires. The immutable `known-problems-report.json` release asset preserves the reviewed pre-signing snapshot and its deferred rows. The completed report is in `forge-stable-qualification`. Finally, use fresh **Check for updates** in the authenticated current installation to verify **Up to date** and record the release URL, version, digest and outcome in the release evidence.

## First installation and stopping a release

From a directory containing the verified versioned delivery, run the exact versioned setup executable from its trusted distribution point.

```powershell
./Forge-Setup-0.0.1.exe install ./forge-release.json ./forge-release.sig ./forge-0.0.1-windows-x64.zip
& (Join-Path $env:LOCALAPPDATA 'Forge/Installation/Forge Launcher.exe') status
& (Join-Path $env:LOCALAPPDATA 'Forge/Installation/Forge Launcher.exe')
```

Use `forge-update-helper.exe verify-release MANIFEST SIGNATURE ZIP` to check a staged package. For a preapproved key transition, append the transition JSON and its detached signature to the verify or install command. See the [manifest and trust contract](../contracts/release-manifest-v1.md).

If setup is interrupted before the first active slot is published, run the same verified install command again. Under the installation lock, setup reads its pending slot record, removes the interrupted slot and retries the signed package. Keep the original delivery until `status` reports the expected version and the launcher opens Forge.

If the candidate digest, signature, tag, provenance or runtime fails, stop before promotion. Retain the failure evidence and remove only the affected unpublished staging delivery after approval. Publish a correction under a new qualified version if the affected release was already public. If a release key may be exposed, freeze signing and discovery immediately, restrict access to the affected environment and preserve the relevant audit evidence. Resume through a trust transition authenticated with an anchor that remains trustworthy or a separately authenticated replacement bootstrap.

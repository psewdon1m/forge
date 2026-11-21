param(
    [Parameter(Mandatory)]
    [ValidatePattern('^(root|[0-9a-f]{40})$')]
    [string]$Base,
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$Head,
    [switch]$Docker
)

$ErrorActionPreference = 'Stop'
$forgeDir = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
Push-Location $forgeDir
try {
    $checkout = git rev-parse --verify HEAD
    if ($LASTEXITCODE -ne 0 -or $checkout -cne $Head) { throw 'Check out the exact outgoing commit first.' }
    $changes = git status --porcelain=v1 --untracked-files=all
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Verify the exact revision from a clean Forge checkout.' }

    if ($Base -ceq 'root') {
        $history = git rev-list --parents -n 1 $Head
        if ($LASTEXITCODE -ne 0 -or $history -cne $Head) { throw 'Use root only for the first commit.' }
        git diff-tree --root --check --no-commit-id -r $Head --
        if ($LASTEXITCODE -ne 0) { throw 'Outgoing diff failed the whitespace check.' }
        git diff-tree --root --name-status --no-commit-id -r $Head --
    } else {
        git merge-base --is-ancestor $Base $Head
        if ($LASTEXITCODE -ne 0) { throw 'Provide the outgoing range from an established base commit.' }
        git diff --check $Base $Head --
        if ($LASTEXITCODE -ne 0) { throw 'Outgoing diff failed the whitespace check.' }
        git diff --name-status $Base $Head --
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the outgoing file list.' }

    & (Join-Path $PSScriptRoot 'setup.ps1')
    if ($Docker) {
        & (Join-Path $PSScriptRoot 'build-core-windows-dev.ps1')
        docker run --rm --mount "type=bind,source=$forgeDir,target=/forge" --mount 'type=volume,source=forge-cargo-registry,target=/usr/local/cargo/registry' --mount 'type=volume,source=forge-cargo-target,target=/forge/target' forge-core-windows-dev:1.94.1 bash -c 'cargo fmt --all --check && cargo test --locked --workspace --all-features && cargo clippy --locked --workspace --all-targets --all-features --target x86_64-pc-windows-gnu -- -D warnings'
        if ($LASTEXITCODE -ne 0) { throw 'Rust verification failed.' }
    } else {
        cargo fmt --all --check
        if ($LASTEXITCODE -ne 0) { throw 'Rust format check failed.' }
        cargo test --locked --workspace --all-features
        if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }
        cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
        if ($LASTEXITCODE -ne 0) { throw 'Rust lint failed.' }
        cargo build --locked --release -p forge-core
        if ($LASTEXITCODE -ne 0) { throw 'Windows Core build failed.' }
        New-Item -ItemType Directory -Path '.local/bin' -Force | Out-Null
        Copy-Item -LiteralPath 'target/release/forge-core.exe' -Destination '.local/bin/forge-core.exe'
    }
    & (Join-Path $PSScriptRoot 'verify.ps1') -Suite All
    node tests/research-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Research source provenance and project restore verification failed.' }
    node tests/research-transcription-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Research transcription approval, provider and restore verification failed.' }
    node tests/intelligent-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Intelligent context and provider verification failed.' }
    node tests/plain-panes-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Paired Plain layout and state verification failed.' }
    node tests/comparison-formats-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Comparison document text, pixel differences and restore verification failed.' }
    node tests/editor-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Editor graph, cancellation, export and restore verification failed.' }
    node tests/gallery-video-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Gallery video playback, Palette filtering and restore verification failed.' }
    node tests/git-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Git working tree status, review, mutations and restore verification failed.' }
    $release = @('tests/release-windows.mjs', '--updates', '--committed')
    if ($Docker) { $release += '--docker' }
    node @release --candidate-target --manual-rollback
    if ($LASTEXITCODE -ne 0) { throw 'Exact candidate first install, update and manual rollback verification failed.' }
    node @release --manual-rollback --rollback-crashes
    if ($LASTEXITCODE -ne 0) { throw 'Interrupted manual rollback verification failed.' }
    node @release --failed-startup
    if ($LASTEXITCODE -ne 0) { throw 'Automatic update rollback verification failed.' }
    node @release --interrupted-startup
    if ($LASTEXITCODE -ne 0) { throw 'Interrupted activation recovery verification failed.' }

    Write-Output "Automated pre-push checks passed for $Base to $Head. Attach the seven-area Part 06 review for this range."
} finally {
    Pop-Location
}

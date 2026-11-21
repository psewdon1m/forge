param(
    [Parameter(Mandatory)]
    [ValidateSet('candidate')]
    [string]$Channel,
    [switch]$Docker
)

$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    if ($Docker) {
        & (Join-Path $PSScriptRoot 'build-core-windows-dev.ps1')
    } else {
        cargo build --locked --release -p forge-core
        if ($LASTEXITCODE -ne 0) { throw 'Windows Forge Core build failed.' }
        New-Item -ItemType Directory -Path '.local/bin' -Force | Out-Null
        Copy-Item -LiteralPath 'target/release/forge-core.exe' -Destination '.local/bin/forge-core.exe'
    }

    & (Join-Path $PSScriptRoot 'verify.ps1') -Suite Integration

    $packageArguments = @('tests/release-windows.mjs')
    if ($Docker) { $packageArguments += '--docker' }
    node @packageArguments
    if ($LASTEXITCODE -ne 0) { throw 'Candidate packaging or signed first-install smoke failed.' }
} finally {
    Pop-Location
}

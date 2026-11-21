$ErrorActionPreference = 'Stop'
$forgeDir = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
Push-Location $forgeDir
try {
    docker build --tag forge-core-windows-dev:1.94.1 --file scripts/Dockerfile.windows-core-dev scripts
    if ($LASTEXITCODE -ne 0) { throw 'Windows development builder could not be built.' }
    docker run --rm --mount "type=bind,source=$forgeDir,target=/forge" --mount 'type=volume,source=forge-cargo-registry,target=/usr/local/cargo/registry' --mount 'type=volume,source=forge-cargo-target,target=/forge/target' forge-core-windows-dev:1.94.1 bash -c 'cargo build --locked --release --target x86_64-pc-windows-gnu -p forge-core && mkdir -p .local/bin && cp target/x86_64-pc-windows-gnu/release/forge-core.exe .local/bin/forge-core.exe'
    if ($LASTEXITCODE -ne 0) { throw 'Windows Forge Core build failed.' }
} finally { Pop-Location }

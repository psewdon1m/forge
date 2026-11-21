$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    node node_modules/typescript/bin/tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
    node node_modules/vite/bin/vite.js build
    if ($LASTEXITCODE -ne 0) { throw 'Desktop UI build failed.' }
    node node_modules/electron/cli.js .
    if ($LASTEXITCODE -ne 0) { throw 'Forge could not start.' }
} finally { Pop-Location }

$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24.14.0 first.' }
    if ((node --version) -ne 'v24.14.0') { throw 'This qualification build requires Node.js 24.14.0.' }
    if ((npm.cmd --version) -ne '11.9.0') { throw 'This qualification build requires npm 11.9.0.' }
    npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    node -p "require('electron')"
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime installation failed.' }
} finally { Pop-Location }

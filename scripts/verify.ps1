param(
    [ValidateSet('Unit','Integration','E2E','Security','Docs','All')]
    [string]$Suite = 'All'
)
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    if ($Suite -in @('Unit', 'All')) {
        node --test tests/*.test.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Unit verification failed.' }
    }
    if ($Suite -in @('Integration', 'E2E', 'All')) {
        node node_modules/typescript/bin/tsc --noEmit
        if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
        node node_modules/vite/bin/vite.js build
        if ($LASTEXITCODE -ne 0) { throw 'Desktop UI build failed.' }
        node tests/desktop-smoke.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Desktop smoke failed.' }
    }
    if ($Suite -in @('Security', 'All')) {
        npm.cmd audit --audit-level=high
        if ($LASTEXITCODE -ne 0) { throw 'Dependency audit failed.' }
    }
    if ($Suite -in @('Docs', 'All')) {
        node scripts/check-docs.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Documentation verification failed.' }
    }
} finally { Pop-Location }

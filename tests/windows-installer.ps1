param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$PackageSha256
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).ProviderPath
$appId = '{738940DB-1491-459D-92DF-8571C6C3460C}_is1'
$uninstall = "HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/$appId"
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Forge.lnk'
if ((Test-Path -LiteralPath $uninstall) -or (Test-Path -LiteralPath $desktop)) {
    throw 'Use an isolated Windows profile with no existing Forge wizard registration or desktop shortcut.'
}

$fixtureId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$fixture = Join-Path $env:TEMP "Forge-Wizard-$fixtureId"
$destination = Join-Path $fixture 'Custom Forge Folder'
$installation = Join-Path $destination 'Installation'
$launcher = Join-Path $installation 'Forge Launcher.exe'
$group = "Forge Qualification $fixtureId"
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) "$group/Forge.lnk"
$log = Join-Path $fixture 'install.log'
New-Item -ItemType Directory -Path $fixture | Out-Null
$shell = New-Object -ComObject WScript.Shell

function Invoke-Wizard([string]$Tasks) {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
        ('/DIR="' + $destination + '"'), ('/GROUP="' + $group + '"'), ('/TASKS="' + $Tasks + '"'),
        ('/LOG="' + $log + '"'))
    $result = Start-Process -FilePath $installerPath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    if ($result.ExitCode -ne 0) {
        if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 30 }
        throw "Forge installer failed with exit code $($result.ExitCode)."
    }
    $record = & $launcher status | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $record.version -ne $Version -or $record.packageSha256 -ne $PackageSha256) {
        throw 'The launcher did not verify the installed version and package.'
    }
    return $record
}

function Verify-Shortcut([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf) -or $shell.CreateShortcut($Path).TargetPath -ne $launcher) {
        throw "The shortcut does not target the selected installation: $Path"
    }
}

$initial = Invoke-Wizard ''
Verify-Shortcut $menu
if (Test-Path -LiteralPath $desktop) { throw 'Setup created a desktop shortcut without selection.' }
$profile = Join-Path $destination 'Profile'
$sentinel = Join-Path $profile 'qualification.txt'
New-Item -ItemType Directory -Path $profile | Out-Null
[IO.File]::WriteAllText($sentinel, 'Retained Forge profile')
$entry = Join-Path $installation "slots/$($initial.slot)/resources/app/dist/index.html"
$entryHash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
[IO.File]::WriteAllText($entry, 'Damaged installer qualification file')
$repeat = Invoke-Wizard 'desktopicon'
if ($repeat.slot -ne $initial.slot -or (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash -ne $entryHash -or
    [IO.File]::ReadAllText($sentinel) -ne 'Retained Forge profile') {
    throw 'Reinstall did not restore the release files and preserve the active slot and profile.'
}
Verify-Shortcut $desktop
if (!(Test-Path -LiteralPath $uninstall)) { throw 'Forge is missing from installed apps.' }

$uninstaller = @(Get-ChildItem -LiteralPath (Join-Path $destination 'Installer') -File -Filter 'unins*.exe')
if ($uninstaller.Count -ne 1) { throw 'Expected one Forge uninstaller.' }
$result = Start-Process -FilePath $uninstaller[0].FullName -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru -WindowStyle Hidden
if ($result.ExitCode -ne 0 -or (Test-Path -LiteralPath $installation) -or
    (Test-Path -LiteralPath $desktop) -or (Test-Path -LiteralPath $menu) -or (Test-Path -LiteralPath $uninstall) -or
    [IO.File]::ReadAllText($sentinel) -ne 'Retained Forge profile') {
    throw 'Uninstall did not remove managed files and shortcuts while preserving the profile.'
}

$active = Invoke-Wizard 'desktopicon'
$worker = Join-Path $fixture 'forge-removal.exe'
Copy-Item -LiteralPath (Join-Path $installation "slots/$($active.slot)/forge-update-helper.exe") -Destination $worker
$nestedProject = Join-Path $installation 'Nested project/.forge/workspace.sqlite'
New-Item -ItemType Directory -Path (Split-Path -Parent $nestedProject) -Force | Out-Null
[IO.File]::WriteAllText($nestedProject, 'Preserved project metadata')
& $worker remove-installation $installation
if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $launcher) -or (Test-Path -LiteralPath $sentinel) -or
    (Test-Path -LiteralPath $desktop) -or (Test-Path -LiteralPath $menu) -or (Test-Path -LiteralPath $uninstall) -or
    [IO.File]::ReadAllText($nestedProject) -ne 'Preserved project metadata') {
    throw 'Full removal did not remove local application data and retain the nested project.'
}
Remove-Item -LiteralPath $worker

[ordered]@{
    outcome = 'PASS'
    version = $Version
    packageSha256 = $PackageSha256
    customDestination = $true
    startMenuShortcut = $true
    uncheckedDesktopShortcut = $true
    selectedDesktopShortcut = $true
    reinstallRestoredReleaseFilesAndPreservedSlot = $true
    uninstallPreservedProfile = $true
    fullRemovalRemovedApplicationDataAndPreservedNestedProject = $true
} | ConvertTo-Json -Compress

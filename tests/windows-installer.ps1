param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$PackageSha256,
    [switch]$LocalPreview
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).ProviderPath
$appId = if ($LocalPreview) { "Forge.Local.${Version}_is1" } else { '{738940DB-1491-459D-92DF-8571C6C3460C}_is1' }
$name = if ($LocalPreview) { 'Forge Local' } else { 'Forge' }
$uninstall = "HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/$appId"
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) "$name.lnk"
if ((Test-Path -LiteralPath $uninstall) -or (Test-Path -LiteralPath $desktop)) {
    throw 'Use an isolated Windows profile with no existing Forge wizard registration or desktop shortcut.'
}

$fixtureId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$fixture = Join-Path $env:TEMP "Forge-Wizard-$fixtureId"
$destination = if ($LocalPreview) {
    Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Forge $Version Local"
} else {
    Join-Path $fixture 'Custom Forge Folder'
}
$installation = Join-Path $destination 'Installation'
$launcher = Join-Path $installation 'Forge Launcher.exe'
$group = if ($LocalPreview) { $name } else { "Forge Qualification $fixtureId" }
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) "$group/$name.lnk"
$log = Join-Path $fixture 'install.log'
New-Item -ItemType Directory -Path $fixture | Out-Null
$shell = New-Object -ComObject WScript.Shell
if ($LocalPreview) {
    $stable = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Forge/Installation/active.json'
    if (Test-Path -LiteralPath $stable) { throw 'Use an isolated Windows profile for the Stable installation fixture.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $stable) -Force | Out-Null
    [IO.File]::WriteAllText($stable, '{"schemaVersion":1,"version":"0.0.4","packageSha256":"545e2f01c9c5ae8291ff86038d6735cdc5097b68a30d726c367facccddc6d896","slot":"0c47c730-6ae6-4f1f-a835-bd38c06453ea"}')
    $stableSha256 = (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash
}

function Invoke-Wizard([string]$Tasks) {
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/TASKS="' + $Tasks + '"'), ('/LOG="' + $log + '"'))
    if (!$LocalPreview) {
        $arguments += @(('/DIR="' + $destination + '"'), ('/GROUP="' + $group + '"'))
    }
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

if ($LocalPreview -and (Get-FileHash -LiteralPath $stable -Algorithm SHA256).Hash -ne $stableSha256) {
    throw 'The local installer changed the Stable installation fixture.'
}

[ordered]@{
    outcome = 'PASS'
    version = $Version
    packageSha256 = $PackageSha256
    customDestination = !$LocalPreview
    localPreviewDefaultAndStableIsolation = [bool]$LocalPreview
    startMenuShortcut = $true
    uncheckedDesktopShortcut = $true
    selectedDesktopShortcut = $true
    reinstallRestoredReleaseFilesAndPreservedSlot = $true
    uninstallPreservedProfile = $true
    fullRemovalRemovedApplicationDataAndPreservedNestedProject = $true
} | ConvertTo-Json -Compress

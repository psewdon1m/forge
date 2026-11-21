param(
    [ValidateSet('Import', 'UpdateBackup')]
    [string]$Suite = 'Import',
    [switch]$Docker
)

$ErrorActionPreference = 'Stop'
$forgeDir = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The disposable VHD qualification requires an elevated PowerShell.'
}
if (-not (Test-Path -LiteralPath (Join-Path $forgeDir '.local/bin/forge-core.exe') -PathType Leaf)) {
    throw 'Build the Windows Core before running this qualification.'
}
$qualification = Join-Path $forgeDir '.local/qualification'
New-Item -ItemType Directory -Path $qualification -Force | Out-Null
$run = Join-Path $qualification ('storage-full-' + [guid]::NewGuid().ToString('N'))
if ($run -match '[^\x20-\x7e]|"') { throw 'The DiskPart fixture path must use printable ASCII without quotes.' }
New-Item -ItemType Directory -Path $run | Out-Null
$run = (Resolve-Path -LiteralPath $run).Path
$image = Join-Path $run 'fixture.vhdx'
$mountPoint = Join-Path $run 'Volume'
$commands = Join-Path $run 'create-vhd.txt'
$output = Join-Path $run 'diskpart.log'
if (Test-Path -LiteralPath $image) { throw 'Expected a new image path.' }
New-Item -ItemType Directory -Path $mountPoint | Out-Null
Set-Content -LiteralPath $commands -Encoding ascii -Value ('create vdisk file="{0}" maximum=64 type=expandable' -f $image)
$existingDisks = @(Get-Disk | Select-Object -ExpandProperty Number)
$creator = Start-Process -FilePath "$env:SystemRoot\System32\diskpart.exe" -ArgumentList @('/s', ('"{0}"' -f $commands)) -WindowStyle Hidden -RedirectStandardOutput $output -Wait -PassThru
if ($creator.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $image -PathType Leaf)) {
    throw "Could not create the fixture VHD. See $output"
}

$attached = $null
$partition = $null
$accessAdded = $false
try {
    $attached = Mount-DiskImage -ImagePath $image -StorageType VHDx -Access ReadWrite -NoDriveLetter -PassThru
    $disks = @($attached | Get-Disk)
    if ($attached.ImagePath -ne $image -or $disks.Count -ne 1) { throw 'The mount did not resolve to a single newly created fixture.' }
    $disk = $disks[0]
    if ($existingDisks -contains $disk.Number -or $disk.IsSystem -or $disk.IsBoot -or
        $disk.BusType -ne 'File Backed Virtual' -or $disk.Size -ne 64MB -or $disk.PartitionStyle -ne 'RAW') {
        throw 'Refused to initialize a disk outside the expected fixture.'
    }
    $initialized = Initialize-Disk -InputObject $disk -PartitionStyle MBR -PassThru
    $partition = New-Partition -InputObject $initialized -UseMaximumSize
    if ($partition.DiskNumber -ne $disk.Number) { throw 'Refused to format a partition outside the fixture.' }
    $volume = Format-Volume -Partition $partition -FileSystem NTFS -NewFileSystemLabel 'Forge-Full-Test' -Confirm:$false
    if ($volume.FileSystem -ne 'NTFS' -or $volume.Size -gt 64MB) { throw 'Unexpected fixture filesystem.' }
    Add-PartitionAccessPath -InputObject $partition -AccessPath $mountPoint -Confirm:$false
    $accessAdded = $true
    if ($Suite -eq 'UpdateBackup') {
        $testArguments = @((Join-Path $forgeDir 'tests/release-windows.mjs'), '--updates', "--full-backup-volume=$mountPoint")
        if ($Docker) { $testArguments += '--docker' }
        node @testArguments
    } else {
        node (Join-Path $forgeDir 'tests/import-storage-full-windows.mjs') $run $mountPoint
    }
    if ($LASTEXITCODE -ne 0) { throw "NTFS qualification failed in $run." }
} finally {
    try {
        if ($accessAdded) {
            Remove-PartitionAccessPath -InputObject $partition -AccessPath $mountPoint -Confirm:$false
        }
    } finally {
        if ($attached) { Dismount-DiskImage -ImagePath $image -StorageType VHDx -Confirm:$false }
    }
}

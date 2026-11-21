# Backup and recovery

## Save a backup

1. Open the project and finish any outstanding edits, imports and file operations. Close external edits to files in the working tree.
2. Open **Settings → Backup** and select **Export project**. Choose a new `.zip` filename outside the project folder.
3. Wait for the message giving the verified revision. Forge writes a temporary ZIP in the destination parent, checks the closed archive and publishes it without overwriting an existing file.

The backup includes the current Space, its viewport and all revisions, project file versions, successful analysis records and their provenance, import receipts, working files and empty folders. User-saved notes and quotes are project data. The backup uses logical records. SQLite files, locks, staging folders, caches, Git metadata, recognized credential paths, application settings and browser sessions are outside project scope. The path exclusions also cover `.env` variants and filenames ending in `.key`, `.pem`, `.pfx` or `.p12`. Review the working tree before exporting. Ordinary files copied by Forge may contain sensitive content, and the ZIP uses no encryption.

## Inspect and restore a copy

1. Open **Settings → Backup** from any screen. Select **Inspect archive** and choose the ZIP.
2. Verify the source title, revision and member counts in the inspection summary. Select **Restore as copy** and choose a parent outside any existing project. Forge creates a new `Forge restored …` folder and lists the project under **Projects**.
3. Open the copy from **Projects**. Confirm that its Space, files and analysis results are available and that the original is still present.

The copy receives a new project ID. The metadata records the immediate source project ID. Node, link, group, file version and analysis IDs are retained. The history retains revision numbers and event metadata. Snapshot hashes are recalculated with the copy's project ID. A restored copy can be exported again.

## Archive a project in the catalog

Open the project, then go to **Projects → Archive project** and confirm. Archiving closes the project and removes its recent entry. Its existing folder remains available through **Open project**. Create a ZIP backup separately when you need a portable copy.

## Save and restore application settings

1. Choose the **Snap to grid** state in Space. Forge saves this preference in the current OS-user profile.
2. Open **Settings → Backup → Application settings** and select **Export settings**. Choose a new ZIP filename and wait for the verified save message.
3. In the destination profile, select **Inspect settings archive** and open the ZIP. Check its name, schema, version and saved grid preference. Select **Restore settings** and confirm the application-preference replacement in the native dialog. The preference applies immediately and survives restart.

The settings scope contains the portable application preference. Project files, project history, the Recent Projects catalog, browser profiles and operational diagnostics each have a separate lifecycle. The shared backup manifest declares `scope: settings` and lists `data/settings.json` with its byte count and SHA-256. The restore transaction compares the selected archive hash and the destination settings revision. If either changes after inspection, inspect the archive again before confirming.

## Update recovery archive

The update controller uses a separate recovery scope that carries application preferences and each project affected by the candidate. Keep the selected ZIP for the lifetime of the rollback option. The archive corresponds to the version and job recorded in its receipt. Forge's update recovery contract specifies the byte and scope checks used when preparing or opening that archive. [Update backup contract](../contracts/update-backup-v1.md)

If the installation was interrupted, open **Forge Launcher** again. It reads the local update journal and reconciles a pending switch. For **Update prepared**, open **Settings → Updates → Continue installation** and select the original ZIP while its receipt is current. An expired receipt requires a fresh backup and installation attempt. For **Previous version restored**, confirm the installed version in Updates and keep the saved ZIP with the affected delivery evidence. [Activation and startup checks](../contracts/update-activation-v1.md)

If neither slot opens, run the launcher from a PowerShell window so its recovery result stays visible. Capture the installed version and the sanitized `phase`, `issue` and `recoveryIssue` fields. Keep the original ZIP and both version slots available for operator recovery.

```powershell
$forgeInstallation = Join-Path $env:LOCALAPPDATA 'Forge/Installation'
& (Join-Path $forgeInstallation 'Forge Launcher.exe') status
& (Join-Path $forgeInstallation 'Forge Launcher.exe')
Get-Content -LiteralPath (Join-Path $forgeInstallation 'update-job.json') -Raw |
  ConvertFrom-Json | Select-Object phase, issue, recoveryIssue
```

## Roll back from Settings

1. Open **Settings → Updates** and choose **Roll back to** for the verified previous version of the last completed update. Review the version and the warning about application settings changed after the backup.
2. Use **Go to project backup** if you want a separate export of the open project. Return to Updates and confirm rollback.
3. Choose the original ZIP Forge saved for this update. Wait for Forge to restart. Check **Rollback complete** and the installed version in Updates.

If Forge rejects the ZIP, choose the original update archive. If the previous version fails its startup checks, Forge reopens the current version and reports the failure in its update job. Retain the archive for another attempt. [Manual rollback contract](../contracts/update-activation-v1.md#manual-rollback).

If Updates reports insufficient space on the backup volume, choose a destination with room for the complete ZIP. On the Windows development host, `./scripts/verify-ntfs-storage-full.ps1 -Suite UpdateBackup -Docker` verifies the low-space outcome using a disposable NTFS volume.

## Validation and errors

The `forge-project-backup` schema 1 manifest lists each logical data, history and file member with its SHA-256, byte count and record count where applicable. The reader checks ZIP structure, path rules and limits before writing a new project. It compares the archive's SHA-256 with the inspection selection. Restoration builds the database and files in a temporary sibling directory, checks SQLite and project relationships, then publishes the complete directory. The shell keeps file paths and the inspection hash in the privileged process.

- A conflicting revision or changed source tree requires a new export after outstanding writes settle.
- A checksum failure, unsupported schema or unsafe pathname stops the operation. Obtain a verified backup from a supported Forge version.
- The project profile supports a ZIP of at most 4 GiB, at most 8 GiB of uncompressed data, at most 10,000 file and folder records including ZIP control members, and at most 200:1 expansion for compressed members. Forge writes STORE entries. External linked files, junctions and hard links are outside this profile.
- If a destination exists, select a different filename or parent folder. If storage is insufficient, select a destination volume with space for the archive or for the reconstructed project and temporary files.
- A normal failure before publication cleans up Forge's own temporary directory. A process or host crash can leave a `.forge-backup-…` sibling in the chosen destination. Confirm the owning Forge process has exited before removing the abandoned temporary directory. An inspected ZIP or published restored project can be opened independently of that directory.

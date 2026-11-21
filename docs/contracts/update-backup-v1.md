# Update backup contract

Forge Core prepares a logical recovery point for a candidate whose migration scope has been resolved by the update controller. The controller supplies the update job UUID, target version and package SHA-256, current settings revision, and the exact affected project UUIDs and revisions. The caller holds an opened Forge writer for each affected project. Settings are always in scope. An update with an empty project list archives settings alone.

## Preparation and handoff

1. Pass the approved scope and opened project handles to **prepare_update_backup**. Core checks that every scoped project appears once and captures its expected revision. It validates the project state, registered assets and working tree. An immediate SQLite transaction pins settings. The prepared handle borrows the project writers and keeps their SQLite read transactions open.
2. The same ZIP builder writes settings and project logical members into a bounded buffer. Core verifies the envelope, each member and all scope identities before returning the prepared archive. It checks working-tree fingerprints after writing all projects and again before saving.
3. Call **save** with the operator-selected new ZIP path. Core writes the exact memory buffer to the selected file, syncs and verifies its content, and issues a receipt. A normal write failure clears the incomplete output. A host or process interruption can leave an incomplete user-selected file. The job controller requires a returned receipt before installation acceptance.
4. Call **for_install** with that receipt immediately before handing the data to the helper. The call checks the 15-minute lifetime, verifies the saved file SHA-256 and verifies current working-tree fingerprints. It returns a borrowed view of the original ZIP. The prepared object owns one archive buffer and the source guards until the controller accepts the helper or cancels. The controller is responsible for the subsequent helper-side write barrier.

Job metadata carries the receipt and package identity. The selected local path and archive bytes stay in the prepared object's memory and the chosen user file. The update controller uses the signed candidate's migration contract to include every project whose state can change.

The current Windows helper owns the prepared object for the entire [update preparation](update-staging-v1.md). The supported policy covers the settings revision and an empty project scope, since it preserves both schemas.

## ZIP layout

| Member | Contents |
| --- | --- |
| manifest.json | Common forge-project-backup envelope, schema 1, update scope, revert mode. The update block records job and candidate identity, settings revision, ordered project IDs and revisions, and existing project copy provenance. |
| data/settings.json | The same logical preference record used for manual settings backup. |
| projects/PROJECT-ID/data/ | Logical project header, working folder names, assets, analyses, navigation and import receipts. |
| projects/PROJECT-ID/history/ | Project revision records. |
| projects/PROJECT-ID/files/ | Verified asset versions and eligible working files. |

Project member layouts and validation match a manual project ZIP. The common manifest covers exact byte counts, SHA-256 digests and logical record counts. The update envelope accepts up to 128 MiB of ZIP bytes and up to 128 MiB of declared uncompressed members. The aggregate entry limit is 10,000 files, control members and folders, with up to 128 projects and at most 200:1 expansion for compressed members. The exporter uses STORE and accounts for ZIP headers against the actual 128 MiB cap. An out-of-budget scope fails before a save receipt exists.

## Recovery

Use **open_update_backup** for a user-selected ZIP or **RecoveredUpdateBackup::from_bytes** for the helper's in-memory copy. Both compare the exact archive size, SHA-256 and identity to the stored receipt. A previously accepted receipt can verify its original recovery file after the installation window.

**stage_project** prepares a complete project in an unused location on the destination volume. It validates its database, history and references, and publishes the staged tree at the caller's designated unused path. The tree preserves the project UUID, its source provenance, resource IDs and original revision digests. The caller can read the archived preferences for the settings transaction. The activation transaction, byte transport, durable job journal, candidate health check and restart recovery belong to the update controller and helper. They coordinate staging for all affected projects before applying recovery to the live profile. Preserve existing out-of-scope files and profiles during activation.

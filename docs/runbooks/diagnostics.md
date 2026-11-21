# Local diagnostics

Open **Logs** from the main navigation. **Local diagnostics** lists the latest 200 retained operations for the current OS profile. Use **Load older events** for the next page and **Latest events** to return. The table pauses while hidden. **Show new events** appears when an update arrives while you are reading lower in the latest page. **Project history** appears below diagnostics when a project is open and provides revision recovery.

Select **Download archived logs** and choose a new ZIP in the native Save dialog. Use the correlation ID to match a reported error to its operation. The export includes the retained audit window, expanded structured errors, retained startup and shutdown events, and the active retention limits. The export outcome is added to the audit after the archive is saved or the operation ends.

## Stored fields and access

The interactive recorder uses a fixed event schema. It accepts operation and outcome, a stable error code, the project UUID when an operation has one, and a generated correlation UUID. Forge adds the UTC timestamp, event ID, OS actor type and transport. An unfamiliar error code is recorded as UNCLASSIFIED. The event protocol has fields for approved identifiers and enum values. User inputs such as project titles, note contents, paths, URLs, headers and exception text fall outside that schema. Error cause and stack trace are null.

The installed application uses the current OS user's application-data profile. A trusted top-level desktop frame requests the audit page or opens a native save picker. Electron main supplies the profile and destination to a diagnostics process. Archive generation writes a bounded temporary file and publishes it atomically without replacing a prior file. A ZIP includes project identifiers and operational timestamps. Review the export before sharing it.

## Retention and storage

| Limit | Value |
| --- | --- |
| Audit rows | 10,000 events and up to 30 days |
| Estimated retained audit payload | 64 MiB, bounded by the audit row size and count |
| Maximum event size | 8 KiB |
| Runtime JSONL segments | Six files, up to 5 MiB per file and up to 30 days |
| Diagnostics directory | 64 MiB, including SQLite and its journal |
| Latest or older page | 200 rows |
| Export | Up to ten ZIP members, 96 MiB of output and 120 seconds of ZIP generation |

Retention runs on start and as the running app records or reads events on a new UTC day. Audit append and pruning run in one SQLite transaction. The runtime stream rotates at size, UTC day and process boundaries. SQLite keeps freed pages available to later appends. The interface reports a write failure and warns when the diagnostics volume has less than 64 MiB free.

The archive contains a manifest, an audit JSONL stream, a separate error array, a README and the retained lifecycle JSONL segments. Timestamps in the archive are UTC Unix milliseconds. The desktop list renders them in local time.

From a verified managed install, `manifest.json` also records the installed package SHA-256 and the last native update job, when present. The job includes its ID, phase, source and target versions, and target package SHA-256. Match `update.job.id` to the `correlationId` of the `update-stage` event. This links the package and durable job to the UTC time at which Settings recorded preparation. The snapshot comes from the local updater without a network request. Export still works when the updater is unavailable or the app runs outside a managed install. In those cases the manifest omits `update`.

Copy the Logs reference shown in Updates and match it to an `update-check` or `update-stage` event. Metadata failures record a controlled reason. HTTP failures also record the numeric status and an approved host. A selection rejected during verification has an audit reference before any update job or ZIP exists. A package HTTP failure uses its durable job ID and records the download stage. These events exclude URLs, response bodies and transport exception text.

# Project format v1

Development contract. The selected project directory starts empty and owns a `.forge/` directory. `project.json` stores format identifier, version and stable project UUID. SQLite identifies itself with application ID `0x464F5247` and `user_version=1`. `writer.lock` uses the operating system lock for the open window lifetime.

The current Core stores an immutable revision snapshot with SHA‑256, reason, actor and UTC time. The head points at the current revision and stores the viewport separately. Operation IDs are unique and a repeated ID reproduces the result only for the same request. Every structural edit requires the current base revision. The device project's canonical `Space` is independent of React Flow. Restore appends a new revision. A Plain's original JSON source is preserved as text, including unknown types.

The initial limits are 25,000 Space objects, a 32 MiB serialized revision, 256 KiB note text and 1 MiB Plain payload. Scope extensions for links, files and analysis, history retention and migration beyond v1 are part of later stage work. The development format fails closed on unsupported versions.

The first registered type is `forge.checklist` schema 1. Its payload is an array under `items`; each item has a stable UUID, a label and a done flag. Core validates the layout, up to 100 items, unique task IDs and text limits. The Portal uses a separate stable Plain UUID and shows progress. Task edits enter the project history, and entering the Plain exposes the task controls. Unrecognized type IDs or versions stay available as read-only placeholders.

An optional Space `groups` array describes stable group IDs with two or more distinct member object IDs. Objects can belong to one group. An older snapshot without this field reads as an ungrouped Space. Group construction, movement, separation and archive are structural changes. Paste copies the selection within Forge and generates new group, node, Plain and known task IDs while preserving an unavailable Plain's opaque payload.

The additive `revision_navigation` index records undo and redo targets and never rewrites a historical snapshot. Opening a valid earlier v1 database provisions the table and interprets prior revisions as a linear sequence. A reversal appends a revision, preserves viewport geometry and can itself be replayed by operation ID. Starting a new edit after undo clears the redo path and keeps the earlier snapshots in project history.

## Desktop panel state

**Open beside** opens a second card from the current project at the same level as the first. At 1,120 CSS pixels or more, both Plains have independent scroll areas. A narrower window shows the last active Plain and offers one **Show** button per panel. Switching or resizing retains each open Plain's filters, pagination, selected source and draft. Closing an individual panel keeps the other one open. An editor with unsaved changes must be saved or discarded before it can close. **Back to Space** applies this check to the pair and returns focus to the original canvas control. A pair can include one live Site. Its native view fits the Site panel and hides when the other panel is shown in a narrow window.

The pane selection, scroll positions and drafts are session state. Saved edits in both panels share the project's revision queue and appear in its normal history and backup. Run `node tests/plain-panes-desktop.mjs` after building the Windows desktop and Core to check panel geometry, keyboard focus, Research and Dataset state, and the native Site view.

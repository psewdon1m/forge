# Scheme Plain v1

In **Space**, select **Add Scheme**, then **Open Scheme**. Add rectangles, ellipses, diamonds, text or free lines. Drag an element to move it. Select an element or connection to edit its label. Drag between element handles or use **From element**, **To element** and **Connect elements**. Select a connection to choose **Straight** or **Orthogonal**. Use the middle mouse button to pan and the wheel or inspector buttons to zoom.

**Undo edit** and **Redo edit** cover the latest 40 graph edits in the current session. Importing is one edit that includes the view. **Save scheme** commits a project revision containing elements, connections and the current view. **Discard scheme draft** restores the last saved document. Save or discard before leaving the Plain or opening another JSON file. Saved revisions participate in project history and backups.

## Portable JSON

**Export Scheme JSON** writes a saved Scheme to a new file. The native Save dialog selects the destination. Core checks the project revision and publishes the JSON atomically. If the destination already exists, Core preserves it. **Open Scheme JSON** reads the selected file, validates it and loads it as a draft in the current Scheme. Save the draft to commit it. The graph and view retain their exported values. Space card IDs, project IDs, settings and attachments do not appear in the file.

Files end in `.json`. The open format is UTF-8 JSON with optional UTF-8 BOM on input. Export produces UTF-8 without BOM. The envelope has exactly three fields. `format` is `forge-scheme`, `schemaVersion` is 1 and `document` has ordered `elements` and `lines` arrays and a `viewport`.

```json
{
  "format": "forge-scheme",
  "schemaVersion": 1,
  "document": {
    "elements": [
      {"id":"93003da1-6fb2-42bf-9a03-a748b05d0721","kind":"rectangle","position":{"x":45,"y":42},"width":146,"height":76,"text":"Camera"},
      {"id":"6d0c41bd-2eb1-4d7e-a528-1f0170007429","kind":"ellipse","position":{"x":237,"y":42},"width":146,"height":76,"text":"Lighting"}
    ],
    "lines": [
      {"id":"89bf2664-6a0b-4b74-8ca6-ad5e2d98d03d","from":"93003da1-6fb2-42bf-9a03-a748b05d0721","to":"6d0c41bd-2eb1-4d7e-a528-1f0170007429","route":"orthogonal","text":"Key light"}
    ],
    "viewport":{"x":0,"y":0,"zoom":1}
  }
}
```

| Field | Validation |
| --- | --- |
| Document | At most 500 elements and 1,000 connections. Element and connection IDs are non-nil UUIDs unique across the document. |
| Element | `kind` is `rectangle`, `ellipse`, `diamond`, `text` or `line`. `position` is the top-left coordinate in canvas units. Integer `width` and `height` are 16–2048. `angle` is an optional integer from 0 to 359 degrees, clockwise, for `line` only. The default angle is zero. |
| Connection | `from` and `to` reference distinct elements in this document. Free lines cannot be endpoints. Each unordered endpoint pair identifies at most one connection. `route` is `straight` or `orthogonal`. |
| Coordinates and view | Finite `x` and `y` in −1,000,000 to 1,000,000. `viewport.zoom` is finite and in 0.05–8. |
| Labels | `text` is a plain-text string up to 4,096 UTF-8 bytes. An empty string is valid. Of control characters, only LF, CR and tab are accepted. |
| Limits | Input file at most 1 MiB. Canonical document at most 512 KiB. Unknown fields and versions are rejected. |

## Adapter and Data Links

The Scheme UI reuses the existing pinned `@xyflow/react@12.12.1` dependency for node dragging, selection, edges and viewport. The adapter maps Forge elements and connections to React Flow nodes and edges at render time. Project snapshots store a `forge.scheme` portal with `schemaVersion: 1` and the JSON-encoded `document` as its payload. The format above defines interoperability independently of the React Flow renderer. [React Flow data model](https://reactflow.dev/api-reference/types/react-flow-json-object).

- `text` provides **TextContent** for Comparison. It joins nonempty element labels in element order and then nonempty connection labels in line order using LF.
- `graph` provides **GraphData** as ordered `elements` and `lines` with a SHA-256 `sourceRevision`. An optional expected revision detects changed contents. A view-only edit leaves the graph revision unchanged.
- Copy and paste in Space creates new object and element UUIDs, then remaps the copied connections to their new endpoints. Opening portable JSON as a draft preserves its graph IDs within the destination Plain.

Run `node tests/scheme-desktop.mjs` after building the desktop and Core to replay the Windows editor, portable format, restart and Comparison checks.

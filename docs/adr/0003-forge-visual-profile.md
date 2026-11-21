# ADR 0003 — Forge visual profile

Status: owner direction recorded in the production plan. Reference acceptance is in progress.

The design references recorded in the production plan define the light work area, square dividers, typographic hierarchy, orthogonal arrows, toolbar position and inversion of selected commands. Forge uses Space Grotesk Variable, IBM Plex Mono and a one-pixel structural border. This source distribution draws an anvil from a CSS polygon in the [desktop stylesheet](../../ui/src/style.css). The supplied reference files are retained in the design workspace. File-import qualification uses a synthetic geometric grid in `tests/fixtures/forge-test-grid.png`.

The palette, typography and shell are a Forge variation of Part 01. Required keyboard, focus, accessibility, documentation, confirmation and recovery behavior remains applicable. The deviation can be reversed through the presentation layer with no project-format migration.

# Checklist Plain

In Space, create a **Checklist** and open its Portal. Add tasks under **New task**. Create a group under **New group**, then assign tasks with their group selectors. Removing a group sends its tasks to **Ungrouped**.

Use the arrow buttons or focus a task and press **Alt+↑** or **Alt+↓** to change its position within the group. The moved task retains focus. Check a task to record its completion. The interface shows the completion time in the OS user's locale and displays the project revision that recorded the mark.

## Storage and compatibility

- The Portal uses **forge.checklist** with schema version 1. Its payload contains up to 100 **items** and 20 optional **groups**, each with a stable UUID and a label.
- An item has a label, a Boolean **done**, and an optional **groupId**. Core rejects duplicate IDs and group references outside the same Checklist.
- Core creates **completion** with **occurredAt** in UTC and the committing **revision** when a task becomes checked. Reordering and grouping preserve that record. Clearing the mark removes the current record. Project history preserves previous snapshots and their records.
- Early v1 items contain **id**, **label**, and **done**. Existing completed items without a timestamp display their completed state and indicate that its time is unavailable. A copied Checklist receives fresh task and group IDs, retains its checkmarks and starts with no recorded completion times.

## Outputs

The **text** port publishes **TextContent** in displayed task order. Each group adds a heading. A task starts with a Markdown checkmark or unchecked marker. Comparison reads this text over a normal Data Link. The source revision is the SHA-256 of the published text.

The **completions** port declares **ChecklistCompletionRecords**. The read-only **checklistCompletions** command pages the current checked tasks for the opened project. It returns the group labels and each task's UUID, label, group reference and completion fields when available. The source revision is the SHA-256 of the Checklist payload. Clients pass that revision with additional pages and refresh after **SOURCE_CHANGED**.

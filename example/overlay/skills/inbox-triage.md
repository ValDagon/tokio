---
name: inbox-triage
description: >-
  Triage incoming unstructured notes into tasks, ideas, and reference notes without losing raw captures.
triggers: [triage inbox, sort notes, organize inbox]
---

# Inbox Triage Procedure

Use this skill when organizing raw or unprocessed notes in the inbox.

## Steps
1. Call `get_inbox_digest` to inspect pending items in `raw`.
2. Promote explicit commitments or deadlines to tasks via `add_task`, then clean up or move the source note.
3. Route creative thoughts to `idea` and reference notes to `note` using `move_note`.
4. Never discard receipt photos or financial records before checking them against balances or liabilities.
5. Summarize the changes clearly and concisely.

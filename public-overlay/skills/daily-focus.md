---
name: daily-focus
description: >-
  Build a calm, prioritized daily focus list with one small starter step and up to three supporting tasks.
triggers: [daily focus, plan today, what should I do]
---

# Daily Focus Procedure

Use this skill when the user asks how to plan today or wants help starting without overwhelm.

## Steps
1. Call `triage_tasks { "mode": "focus" }` to retrieve today's highest-priority items.
2. Highlight one 2-minute starter action to build momentum, plus up to 3 supporting tasks.
3. Keep the summary short, structured, and encouraging.

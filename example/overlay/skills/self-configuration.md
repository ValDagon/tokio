---
name: self-configuration
description: >-
  Conversational system configurator: inspect and update user profile, AI settings,
  ADHD shield and focus limits, financial aliases and runway, diary templates, proactive
  jobs, quiet hours, custom recurring routines, personas, learned rules, skills, presets,
  and safe rollbacks.
triggers: [settings, configure, change model, change language, timezone, persona, preset, rollback settings, reset settings, quiet hours, routine, overload shield, diary template, account alias, reserve]
---

# Conversational Self-Configuration

Use this skill whenever the user wants to inspect or change assistant behavior, ADHD guardrails, financial rules, diary templates, proactive delivery schedules, custom routines, personas, rules, skills, categories, or session state directly from chat.

## 1. Inspect First
- Before mutating settings, routines, rules, personas, or skills, inspect the current state with `get_settings` (use `section`: `all`, `adhd`, `finance`, `diary`, `proactive`, `routines`, `miniapp`, etc.), `manage_routines { "action": "list" }`, `manage_rules { "action": "list" }`, `manage_personas { "action": "list" }`, or `list_skills`.
- Present current settings cleanly by section without overwhelming text walls.

## 2. Show Clear Before -> After Diffs & Rollback
- After any applied configuration change, report a concise `before -> after` summary.
- Remind the user they can undo recent changes anytime with `reset_or_rollback_settings { "action": "rollback" }` (up to 10 steps).

## 3. Two-Tier Safety Policy
- **Applied immediately:**
  - profile fields (`name`, `language`, `timezone`, `base_currency`, `summary_time`, `low_stimulation_mode`), `assistant_name`, `max_steps` (`4..16`), `temperature` (`0..1`);
  - ADHD controls (`adhd`): overload shield enable/thresholds (`overload_shield_enabled`, `overload_overdue_threshold`, `overload_active_todo_threshold`, night hours), `focus_limit` (`1..10`), `stale_after_days` (`1..30`);
  - Finance rules (`finance`): custom account aliases (`finance_alias_account` + `finance_alias_patterns`), default account per currency (`finance_default_currency` + `finance_default_account`), target EUR reserve (`finance_reserve_eur`), and `runway` parameters;
  - Diary template (`diary`): custom sections (`diary_sections`), default task inclusion (`diary_include_tasks`), header template (`diary_header_template`);
  - Proactive controls (`proactive`): quiet hours (`quiet_hours_*`) and per-job tuning for `morning_digest`, `liability_warning`, `liability_review`, `medication_reminder`, `nightly_consolidation`;
  - Mini App UI (`miniapp`): tab visibility/ordering (`miniapp_tabs`, with `system` always preserved to prevent lockout) and account themes/roles (`miniapp_account_pattern`, `miniapp_account_theme`, `miniapp_account_short_name`, `miniapp_account_role_label`); the Mini App System tab also displays an active overrides, presets, and routine toggles card;
  - Custom routines (`manage_routines`): creating/updating zero-token `text` / `summary` routines, creating/updating `read-only` AI routines (cap: **3** active AI routines per user), `pause`, `resume`, and `preview`;
  - adding/editing/removing individual learned rules (`manage_rules`), switching/upserting personas, creating/renaming categories or accounts, updating medication `refill_threshold`, `/talk` & thread reset, and saving/applying presets.
- **Requires deterministic user confirmation ("yes"):**
  - changing `model_provider` or `preferred_model`;
  - creating or updating an AI routine with `tool_access="allow_writes"`, or deleting any routine (`manage_routines { "action": "delete" }`); when editing an existing `allow_writes` routine, always specify `tool_access` explicitly;
  - activating/disabling/updating/rejecting skills or toggling built-in skills (`manage_skills`);
  - updating/deleting `doc_chapters` (`manage_docs`);
  - deleting categories/personas/presets/backlog items;
  - resetting settings (`action="reset"`, including `adhd`, `finance`, `diary`, `proactive`, `routines`, `all`).
- **Background & Quiet Hours Invariants:**
  - In background AI routines, `destroy` tools, `manage_routines`, and `reset_or_rollback_settings` are ALWAYS disabled, even with `allow_writes`.
  - Explicit user-scheduled task reminders still deliver during quiet hours; proactive digests/warnings/meds and routines with `respect_quiet_hours=true` defer until quiet hours end.

## 4. Never Handle Secrets in Chat
- Never ask for or accept API keys, BYOK secrets, or tokens in LLM chat.
- Direct users to `/byok` or the System tab in the Mini App to configure provider API keys.

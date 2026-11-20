# Tokio Documentation Index

Central navigation for Tokio's core architecture, declarative overlay specification, and contributor guides.

| Document | Path | Purpose |
| :--- | :--- | :--- |
| **Project Overview** | [`README.md`](../../README.md) | Quick start, architecture overview, feature highlights, and overlay entry points (EN / RU / SR / JA). |
| **System Architecture** | [`ARCHITECTURE.md`](ARCHITECTURE.md) | V8 isolate runtime, 24-table SQLite schema, 54 agent tools, Mini App RPC gateway, and security gates. |
| **Level 1 Overlay Spec** | [`OVERLAY-SPEC.md`](OVERLAY-SPEC.md) | Declarative `manifest.json` schema, prompt Markdown interpolation, feature flags, and fallback rules. |
| **Example Overlay & Seed** | [`example/README.md`](../../example/README.md) | Guide to copying `example/overlay/` into `overlay/`, configuring `OVERLAY_DIR`, and using `demo.json`. |
| **Agent Contract** | [`AGENTS.md`](../../AGENTS.md) | Core-vs-Overlay decision rules, boundaries (`ALWAYS`, `ASK FIRST`, `NEVER`), and verification gates. |
| **Contributing Guide** | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Local development setup, 4-locale i18n policy, PR checklist, and pre-push leak checks. |
| **Security Policy** | [`SECURITY.md`](../../SECURITY.md) | Private vulnerability reporting, supported versions, and cryptographic/tenant isolation model. |

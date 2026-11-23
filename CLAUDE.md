# Claude / Multi-Harness Entrypoint

Read these files in order before making changes:

1. `AGENTS.md` — Core vs. Overlay rule, agent boundaries, verification gates, and V8 isolate invariants.
2. `docs/system/INDEX.md` — System documentation index.
3. `docs/system/ARCHITECTURE.md` — Runtime architecture, module cap (`<= 100`), 24-table SQLite schema, and native 60-tool agent loop.
4. `docs/system/OVERLAY-SPEC.md` — Level 1 declarative overlay format (`overlay/` / `OVERLAY_DIR` with automatic fallback to `example/overlay/`).

Before finishing or handing off across tools/models, run `npm run check:leaks:history` and verify all backend + Mini App gates pass.

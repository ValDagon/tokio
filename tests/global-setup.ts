/**
 * Deterministic overlay baseline for the test suite.
 *
 * The compiled overlay is whatever the last build produced — a fresh clone gets
 * `example/overlay/`, a private instance gets its own `OVERLAY_DIR`. Behavioural
 * tests (spend limit, onboarding, greeting, summary) must not depend on that
 * choice, so the suite always compiles the public example overlay first.
 *
 * Overlay-specific behaviour is covered directly: `tests/overlay.test.ts`
 * compiles custom overlay directories, and the regular `build` gate runs with
 * the active `OVERLAY_DIR`.
 */
// @ts-expect-error ESM build script without .d.ts
import { compileRuntimeAssets } from '../scripts/compile-runtime-assets.mjs';

export default async function setup(): Promise<void> {
  await compileRuntimeAssets({ overlayDir: 'example/overlay' });
}

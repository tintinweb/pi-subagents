/**
 * isolated-provider.e2e.test.ts — reachability guard for PR #152 (issue #151).
 *
 * PR #152 fixes isolated subagents dropping extension-registered custom providers
 * on Pi >= 0.80.8 (the `modelRegistry` → `modelRuntime` migration). agent-runner
 * forwards the parent's runtime, read off the ModelRegistry facade as
 * `ctx.modelRegistry.runtime` via `as unknown as { runtime }`.
 *
 * That forwarding is already guarded by the unit test in test/agent-runner.test.ts
 * ("passes the parent model runtime …") — but against a MOCK whose `.runtime` is
 * hand-set. The mock cannot catch the one thing that would silently break the fix:
 * `.runtime` is a `private readonly` field on the real ModelRegistry, absent from
 * the public type AND the package exports. If a future Pi renames it, makes it a
 * true #private, or moves the module, the cast quietly yields `undefined`, the fix
 * omits `modelRuntime`, and the bug returns with no failing test.
 *
 * This test closes exactly that gap and nothing else: it asserts the real facade
 * exposes a runtime-reachable `.runtime` that IS the runtime it wraps. It is not a
 * guard for the forwarding itself (that's the unit test's job) — a fuller e2e that
 * drives real `runAgent` end-to-end is tracked as a follow-up.
 *
 * VERSION GATE: `.runtime` only exists in the post-migration facade world (Pi >=
 * 0.80.8, where `ModelRuntime` is first exported). The repo's dev dependency is
 * pinned pre-migration (0.80.6), so we DYNAMICALLY import Pi and skip cleanly when
 * it predates the migration. CI runs a dedicated job on `pi@latest` (see
 * .github/workflows/ci.yml) so this guard actually runs against current Pi.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Dynamic, so this file LOADS on pre-migration Pi (a static `import { ModelRuntime }`
// would be a link-time error there — 0.80.6 doesn't export it).
const pi = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
const ModelRuntime = pi.ModelRuntime as
  | { create(opts?: Record<string, unknown>): Promise<ModelRuntimeLike> }
  | undefined;

// The migration is exactly "ModelRuntime now exists". Absent ⇒ pre-0.80.8 ⇒ there
// is no `.runtime` facade to guard.
const MIGRATED = typeof ModelRuntime?.create === "function";
const RT = ModelRuntime as { create(opts?: Record<string, unknown>): Promise<ModelRuntimeLike> };

// The one method the reach scenario needs; `.runtime` itself is private (reached below).
interface ModelRuntimeLike {
  registerProvider(id: string, config: Record<string, unknown>): void;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!MIGRATED)("PR #152 reach: real ModelRegistry exposes .runtime (Pi >= 0.80.8)", () => {
  it("ctx.modelRegistry.runtime is reachable and IS the runtime it wraps", async () => {
    // A real, configured runtime — as an extension leaves it after registerProvider.
    const dir = mkdtempSync(join(tmpdir(), "iso-prov-"));
    tmpDirs.push(dir);
    const runtime = await RT.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });

    // `.runtime` is private and not in the package exports — reach the compiled
    // class by file path, exactly the field the patch's cast depends on. If Pi
    // moves/renames/#privates it, THIS line fails loudly instead of the fix
    // silently no-op'ing back to the #151 bug.
    const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const mrUrl = indexUrl.replace(/index\.js$/, "core/model-registry.js");
    const { ModelRegistry } = (await import(mrUrl)) as {
      ModelRegistry: new (rt: ModelRuntimeLike) => { runtime?: unknown };
    };

    const facade = new ModelRegistry(runtime);
    // This is the exact expression agent-runner reads (`ctx.modelRegistry.runtime`).
    expect((facade as { runtime?: unknown }).runtime).toBe(runtime);
  });
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  // The print-mode e2e suite (test/subagents-print-mode-e2e.test.ts) drives REAL
  // faux-model turns through pi-coding-agent + pi-agent-core. That requires ONE
  // shared @earendil-works/pi-ai instance so the faux provider the test registers
  // lands in the same api-registry the session streams through. npm physically
  // duplicates pi-ai (a top-level copy and one nested under pi-coding-agent), which
  // otherwise yields two registries and "No API provider registered" errors.
  // Inlining the @earendil-works packages routes them through Vite's resolver so
  // dedupe can collapse pi-ai to a single instance — for the parent AND for every
  // subagent session the extension spawns. dedupe alone is insufficient (it only
  // affects modules Vite resolves; without inline the runtime stays externalized).
  test: {
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});

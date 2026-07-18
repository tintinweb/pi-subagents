/**
 * Real extension fixture "lazy" for the template-driven e2e runner.
 *
 * Registers its tool from `session_start` rather than at load — the shape that
 * broke subagents in issue #125. pi-mcp does exactly this (it can only enumerate
 * tools once its MCP servers connect), and eagerly connecting at load time would
 * orphan child processes on pi's non-agent code paths.
 *
 * The point of the fixture is the TIMING: at `loader.reload()` this extension
 * contributes no tools at all, so any scoping that snapshots the tool set then
 * will drop `lazy_tool` permanently. See ext-alpha.mjs for the conventions.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.on("session_start", () => {
    pi.registerTool({
      name: "lazy_tool",
      label: "lazy_tool",
      description: "Lazily-registered extension tool (e2e fixture).",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "lazy_tool" }] };
      },
    });
  });
}

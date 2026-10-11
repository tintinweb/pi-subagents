/**
 * Real extension fixture with pi's MCP timing: it activates `codemode` at
 * `session_start`, from config, and registers its `codemode`-exposure server
 * tool only once the "server" connects. The test stands in for the connection
 * by calling `globalThis.__lazyMcpConnect()` after the subagent's scope is installed.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.on("session_start", () => {
    pi.setActiveTools([...pi.getActiveTools(), "codemode"]);
    globalThis.__lazyMcpConnect = () =>
      pi.registerTool({
        name: "mcp__lazy__lookup",
        label: "mcp__lazy__lookup",
        description: "mcp__lazy__lookup",
        exposure: "codemode",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "lookup" }] };
        },
      });
  });
}

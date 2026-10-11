/**
 * Real extension fixture for the end-to-end test: one tool per activation
 * case pi distinguishes — `direct` (declared on registration), `codemode` and
 * `deferred` (never declared on registration; pi's MCP tools use these), and
 * `direct` with `defaultActive: false` (declared only when named).
 */
import { Type } from "@sinclair/typebox";

const tool = (name, extra) => ({
  name,
  label: name,
  description: name,
  parameters: Type.Object({}),
  ...extra,
  async execute() {
    return { content: [{ type: "text", text: name }] };
  },
});

export default function (pi) {
  pi.registerTool(tool("exposure_direct", {}));
  pi.registerTool(tool("mcp__probe__codemode_only", { exposure: "codemode" }));
  pi.registerTool(tool("mcp__probe__deferred", { exposure: "deferred" }));
  pi.registerTool(tool("exposure_off_by_default", { defaultActive: false }));
}

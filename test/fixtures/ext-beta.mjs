/**
 * Real extension fixture "beta" for the template-driven e2e runner.
 * Registers a single tool, used to prove that the `ext:` allowlist flip mutes
 * a loaded-but-unselected extension. See ext-alpha.mjs for the conventions.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "beta_tool",
    label: "beta_tool",
    description: "Beta extension tool (e2e fixture).",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "beta_tool" }] };
    },
  });
}

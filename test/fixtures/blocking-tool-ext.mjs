import { Type } from "@sinclair/typebox";

const CONTROL_KEY = Symbol.for("pi-subagents:test:blocking-tool");

export default function (pi) {
  pi.events.on("subagents:completed", (data) => {
    globalThis[CONTROL_KEY]?.agentCompleted(data);
  });
  pi.registerTool({
    name: "blocking_tool",
    label: "Blocking tool",
    description: "Blocks a test-controlled parent tool batch.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const control = globalThis[CONTROL_KEY];
      if (!control) throw new Error("blocking tool test control was not installed");
      control.entered(signal);
      await control.release;
      control.completed(signal);
      return { content: [{ type: "text", text: "blocking tool completed" }] };
    },
  });
}

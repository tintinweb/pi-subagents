import { Type } from "@sinclair/typebox";

export default function (pi) {
  for (const name of ["goal_complete", "goal_blocked"]) {
    pi.registerTool({
      name,
      label: name,
      description: "Goal-mode protocol fixture.",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: name }] };
      },
    });
  }

  pi.events.on("pi-goal:rpc:start", ({ requestId }) => {
    const goalId = "e2e-goal";
    pi.events.emit(`pi-goal:rpc:start:reply:${requestId}`, {
      success: true,
      data: { goalId, status: "active" },
    });
    queueMicrotask(() => {
      pi.events.emit("pi-goal:state", {
        goalId,
        status: "complete",
        summary: "real loader verified",
      });
    });
  });
}

/**
 * Names of tools owned by this extension, whether registered in the host
 * session or injected directly into a subagent session.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  WORKFLOW: "SubagentWorkflow",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
  ASK_PARENT: "ask_parent",
} as const;

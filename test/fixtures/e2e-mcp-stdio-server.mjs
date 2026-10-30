// A minimal MCP server over stdio (newline-delimited JSON-RPC), for the e2e test of
// bare `mcp__` entries in an agent's `tools:` against pi's real MCP extension.
// Serves two tools so the test can prove the agent reaches one and not the other.
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "secret",
    description: "A tool the agent is not allowed to call.",
    inputSchema: { type: "object", properties: {} },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // notifications, e.g. notifications/initialized
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "e2e-fixture", version: "1.0.0" },
        },
      });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({ id, result: { tools: TOOLS } });
    case "tools/call":
      return send({
        id,
        result: { content: [{ type: "text", text: `${params.name}: ${params.arguments?.text ?? "called"}` }] },
      });
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});

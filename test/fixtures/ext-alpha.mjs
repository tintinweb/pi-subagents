/**
 * Real extension fixture "alpha" for the template-driven e2e runner.
 * Registers two tools so narrowing (ext:ext-alpha.mjs/alpha_read) can be
 * distinguished from exposing the whole extension. Plain ESM so node imports
 * it without a TS transform; lives inside the repo tree so `@sinclair/typebox`
 * resolves. Tools are never invoked by the runner — it only inspects the
 * session's active tool set — so execute() is a trivial stub.
 */
import { Type } from "@sinclair/typebox";

export default function (pi) {
  for (const name of ["alpha_read", "alpha_write"]) {
    pi.registerTool({
      name,
      label: name,
      description: `Alpha extension tool ${name} (e2e fixture).`,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: name }] };
      },
    });
  }
}

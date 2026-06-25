/**
 * Real extension fixture for the end-to-end test. Loaded by pi-mono's actual
 * DefaultResourceLoader via `additionalExtensionPaths`. Registers one tool,
 * `e2e_probe`, that writes a marker file when executed so the test can prove
 * the model was actually able to call it (not just that it appeared in a list).
 *
 * Plain ESM (.mjs) so node imports it without any TS transform step.
 */
import { writeFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "e2e_probe",
    label: "E2E Probe",
    description: "Writes a marker file. Used only by the end-to-end test.",
    parameters: Type.Object({
      marker: Type.String({ description: "Absolute path of the marker file to write." }),
    }),
    async execute(_id, params) {
      writeFileSync(params.marker, "probed");
      return { content: [{ type: "text", text: `wrote ${params.marker}` }] };
    },
  });
}

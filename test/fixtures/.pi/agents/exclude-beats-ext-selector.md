---
description: "An ext: selector cannot resurrect an excluded extension."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
exclude_extensions: ext-beta.mjs
tools: "*, ext:ext-beta.mjs"
expect_tools_present: "read"
expect_tools_absent: "beta_tool, alpha_read, alpha_write"
---
e2e template: exclude_extensions beats a tools: ext: selector — beta never
loads, so ext:ext-beta.mjs is an orphan (warns, does not pull beta back in).
Alpha tools are also absent because any ext: entry flips extension tools to an
explicit allowlist and alpha is not selected.

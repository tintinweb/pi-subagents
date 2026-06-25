---
description: "tools omitted (=> all built-ins) with extensions explicitly loaded."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
expect_tools_present: "read, bash, edit, write, grep, find, ls, alpha_read, alpha_write, beta_tool"
---
e2e template: omitting `tools` yields all 7 built-ins; with extensions loaded and
no ext: selector there is no flip, so every loaded extension tool also surfaces.

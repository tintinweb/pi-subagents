---
description: "tools:none => zero built-ins; loaded extension tools still surface."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
tools: none
expect_tools_present: "alpha_read, alpha_write, beta_tool"
expect_tools_absent: "read, bash, edit, write, grep, find, ls"
---
e2e template: `tools: none` yields zero built-ins. With extensions loaded and no
ext: selector, all extension tools still surface — only the built-ins are dropped.

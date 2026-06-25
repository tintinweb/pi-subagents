---
description: "isolated:true forces built-ins only, overriding extensions and ext:."
isolated: true
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
tools: "*, ext:ext-alpha.mjs"
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
e2e template: per the README, isolated:true is hermetic — it forces
extensions:false + skills:false and drops ext: selectors, leaving only built-ins,
even though this template also sets extensions and an ext: selector.

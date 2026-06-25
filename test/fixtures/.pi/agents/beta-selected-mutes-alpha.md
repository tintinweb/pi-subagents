---
description: "Selects beta via ext:; the loaded alpha extension is muted."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
tools: "*, ext:ext-beta.mjs"
expect_tools_present: "read, beta_tool"
expect_tools_absent: "alpha_read, alpha_write"
---
e2e template: mirror of all-and-alpha-selected — selecting beta proves the flip
mutes the *other* loaded extension (alpha) regardless of which one is named.

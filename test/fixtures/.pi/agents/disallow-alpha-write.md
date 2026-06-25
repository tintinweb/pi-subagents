---
description: "Selects alpha but denylists alpha_write via disallowed_tools."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
tools: "*, ext:ext-alpha.mjs"
disallowed_tools: "alpha_write"
expect_tools_present: "read, alpha_read"
expect_tools_absent: "alpha_write, beta_tool"
---
e2e template: disallowed_tools removes an extension tool even when the ext:
selector would otherwise surface it.

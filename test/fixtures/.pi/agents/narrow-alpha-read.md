---
description: "Narrows alpha to a single tool via ext:ext-alpha.mjs/alpha_read."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
tools: "*, ext:ext-alpha.mjs/alpha_read"
expect_tools_present: "read, alpha_read"
expect_tools_absent: "alpha_write, beta_tool"
---
e2e template: ext:<ext>/<tool> narrows alpha to just alpha_read; alpha_write
and the unselected beta extension are both muted.

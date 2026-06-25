---
description: "Loads alpha+beta, selects only alpha via ext:. Flip mutes beta."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
tools: "*, ext:ext-alpha.mjs"
expect_tools_present: "read, bash, alpha_read, alpha_write"
expect_tools_absent: "beta_tool"
---
e2e template: a single ext: selector flips extension tools to an allowlist;
alpha is selected (all its tools surface), beta is loaded but muted.

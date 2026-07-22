---
description: "ext: selecting the lazy extension surfaces its session_start tool."
extensions: "./ext-lazy.mjs, ./ext-alpha.mjs"
tools: "*, ext:ext-lazy.mjs"
expect_tools_present: "read, bash, lazy_tool"
expect_tools_absent: "alpha_read, alpha_write"
---
e2e template: the case a static allowlist can never express. `lazy_tool` does not
exist when the session is constructed, so it cannot be listed up front — scope
has to be re-derived once the extension registers it.

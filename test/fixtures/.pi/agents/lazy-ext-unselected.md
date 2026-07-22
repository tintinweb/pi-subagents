---
description: "A lazy extension left out of the ext: flip stays muted."
extensions: "./ext-lazy.mjs, ./ext-alpha.mjs"
tools: "*, ext:ext-alpha.mjs"
expect_tools_present: "read, bash, alpha_read, alpha_write"
expect_tools_absent: "lazy_tool"
---
e2e template: the mirror of lazy-ext-selected — admitting late tools must not
mean admitting ALL late tools. ext-lazy loads and its session_start handler runs,
but the `ext:` flip did not select it, so `lazy_tool` never becomes active.

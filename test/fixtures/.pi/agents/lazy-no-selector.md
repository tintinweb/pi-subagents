---
description: "A tool registered at session_start reaches the subagent (#125)."
extensions: "./ext-lazy.mjs"
tools: "*"
expect_tools_present: "read, bash, lazy_tool"
---
e2e template: ext-lazy registers `lazy_tool` from `session_start`, i.e. AFTER
loader.reload() has already run. Any scoping that snapshots the tool set at
construction drops it permanently — this asserts it survives.

---
description: "No ext: selector, so all loaded extensions' tools surface."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
tools: "*"
expect_tools_present: "read, alpha_read, alpha_write, beta_tool"
---
e2e template: with no ext: entry there is no flip, so every loaded extension's
tools surface alongside the built-ins.

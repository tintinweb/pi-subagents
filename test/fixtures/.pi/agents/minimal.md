---
description: "Minimal agent — only description and body; every other field omitted."
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
A minimal agent. Per the README defaults: omitted `tools` => all 7 built-ins;
omitted `extensions` => true (all *discovered* extensions load — none exist in
this hermetic fixture, so no extension tools surface). expect_* are test-harness
annotations and are ignored by the agent loader.

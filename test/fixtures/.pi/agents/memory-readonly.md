---
description: "memory read-only — an agent without write tools gets a read-only memory block."
memory: project
tools: read, grep
expect_tools_present: "read, grep"
expect_tools_absent: "write, edit"
expect_prompt_contains: "Agent Memory (read-only), Memory scope: project"
expect_prompt_absent: "persistent memory directory"
---
A read-only memory agent. Per the README, agents without write/edit tools
auto-get a read-only memory fallback: existing memory is injected, no write
access is granted, and no memory directory is created (so `project` scope is
safe here — nothing is written into the repo).

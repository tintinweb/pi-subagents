---
description: "memory read-write — an agent with write tools gets a writable memory block."
memory: user
tools: read, write
expect_tools_present: "read, write, edit"
expect_prompt_contains: "persistent memory directory, Memory scope: user"
expect_prompt_absent: "(read-only)"
---
A write-capable memory agent. Per the README, agents with write/edit tools get
full read-write memory; the memory tool set is completed (edit is auto-added) and
a writable memory block is injected into the system prompt. Scope `user` so the
memory dir is created under the hermetic HOME, never in the repo.

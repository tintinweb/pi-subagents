---
description: "tools value format: YAML flow array."
tools: [read, grep, find]
expect_tools_present: "read, grep, find"
expect_tools_absent: "bash, edit, write, ls"
---
e2e template (format check 3/3): YAML array. Per the README, `[a, b]` == `"a, b"`,
so this must yield the same active tool set as the CSV forms.

---
description: "tools value format: unquoted CSV."
tools: read, grep, find
expect_tools_present: "read, grep, find"
expect_tools_absent: "bash, edit, write, ls"
---
e2e template (format check 1/3): unquoted CSV. Must be equivalent to the quoted
and array forms — see fmt-quoted-csv.md and fmt-array.md.

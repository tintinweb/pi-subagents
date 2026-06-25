---
description: "tools narrowed to two built-ins; extensions omitted (=> true)."
tools: read, grep
expect_tools_present: "read, grep"
expect_tools_absent: "bash, edit, write, find, ls, alpha_read, alpha_write, beta_tool"
---
e2e template: a plain built-in allowlist narrows to exactly the listed tools.
extensions is omitted (defaults to true); none are discovered here, so no
extension tools surface.

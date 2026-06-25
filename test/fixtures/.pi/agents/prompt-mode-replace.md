---
description: "prompt_mode replace (default) — body is the full system prompt."
prompt_mode: replace
expect_tools_present: "read"
expect_prompt_contains: "REPLACE_BODY_MARKER"
expect_prompt_absent: "PARENT_PROMPT_MARKER"
---
REPLACE_BODY_MARKER — in replace mode the parent prompt is NOT inherited, so the
real session's system prompt contains this body but not the parent's marker.

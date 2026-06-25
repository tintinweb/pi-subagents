---
description: "prompt_mode append — body appended to the parent's prompt."
prompt_mode: append
expect_tools_present: "read"
expect_prompt_contains: "PARENT_PROMPT_MARKER, APPEND_BODY_MARKER"
---
APPEND_BODY_MARKER — in append mode the parent prompt flows in verbatim, so the
real session's system prompt contains BOTH the parent marker and this body.

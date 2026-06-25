---
description: "skills: preloads a named skill into the system prompt."
skills: probe-skill
expect_tools_present: "read"
expect_prompt_contains: "Preloaded Skill: probe-skill, SKILL_BODY_MARKER"
---
A skill-preloading agent. The `skills: probe-skill` entry must inject
test/fixtures/.pi/skills/probe-skill.md into the real session's system prompt.

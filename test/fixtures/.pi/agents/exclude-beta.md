---
description: "Loads alpha+beta, excludes beta via exclude_extensions."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
exclude_extensions: ext-beta.mjs
tools: "*"
expect_tools_present: "read, alpha_read, alpha_write"
expect_tools_absent: "beta_tool"
---
e2e template: exclude_extensions removes an extension after the include set is
computed — alpha surfaces normally, beta's tools never register. (Excluding a
name that the extensions: list also loads warns "in both — exclude wins"; the
exclusion still applies.)

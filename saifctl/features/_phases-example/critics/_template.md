<!--
This file demonstrates the `_`-prefix convention: critic discovery skips
files whose name (sans `.md`) starts with `_`, so docs and templates can
sit next to real critics without being treated as malformed critic ids.
-->

You are running as critic `{{critic.id}}`. Read `{{feature.plan}}` and
`{{phase.spec}}`, then audit the diff since `{{phase.baseRef}}`.

This is a placeholder showing the closed mustache variable set:
`feature.{name,dir,plan}`, `phase.{id,dir,spec,baseRef,tests}`,
`critic.{id,round,totalRounds,step,findingsPath}`. See `_README.md` for
the full table.

Note: this template is for the **discover** step (writes to
`{{critic.findingsPath}}`). The fix step uses a saifctl-owned built-in
template — power users can shadow it later via `critics/<id>.fix.md`,
but that's out of scope for v1.

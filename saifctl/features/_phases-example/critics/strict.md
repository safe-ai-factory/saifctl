You are running as critic `{{critic.id}}` (round `{{critic.round}}` of `{{critic.totalRounds}}`)
for phase `{{phase.id}}` of feature `{{feature.name}}`.

This is the **discover** step (`{{critic.step}}`). Your job is to find issues
and write them to `{{critic.findingsPath}}`. **Do NOT modify code in this step**
— a separate fix step will read your findings and apply them.

Read the plan at `{{feature.plan}}` and the phase spec at `{{phase.spec}}`
before starting. The phase's own tests are at `{{phase.tests}}`.

The implementer's diff for this phase is the working-tree history since
`{{phase.baseRef}}`. Inspect with:

    git log {{phase.baseRef}}..HEAD
    git diff {{phase.baseRef}}..HEAD

Project conventions you must apply (inlined verbatim from the project
preamble — same file every critic / phase reads, kept in one place so
updates propagate without editing every template):

{{> file saifctl/features/_phases-example/_preamble.md}}

Beyond the preamble, look for issues including:

- skipped or dropped nuance vs. the plan,
- backwards-compat code left only to avoid touching tests,
- one-off shortcuts that should be a proper helper,
- missing edge-case coverage already implied by the spec.

Write your findings to `{{critic.findingsPath}}` as a markdown checklist:

    - [ ] <file:line> — <one-line description>
          <one-paragraph explanation of why and what to do>

If you find no issues, write exactly `no findings` to that file
(case-insensitive). Either way, the file MUST be created.

# Steer the agent with run rules

Add short instructions to an agent's Run. They are merged into the coding agent's **task prompt**.

You can do this in two ways:

- **Live feedback** — While a run is still executing (`feat run` or `run start`), add rules in another terminal; the agent can see them on the **next inner round** (after the current agent step finishes).
- **Offline feedback** — Add rules after the run has stopped, then [`run start`](../commands/run-start.md) so the next agent run includes your feedback.

**You need:** Docker, and a **Run ID**.

## When to use

- The agent misunderstood the task or keeps doing the wrong thing.
- You want a clear constraint in plain language (paths, patterns, "use X, don't add Y").
- Test output is not enough - you want to say exactly what should change before the next attempt.

**Different problem?** To **edit files yourself** in the agent’s sandbox, use [Fix agent mistakes: inspect, then run start](inspect-and-start.md). You can use both: rules for instructions, inspect for direct code fixes.

## Before you start

- **Run ID** — Obtain from `saifctl run list`, or printed when a run stops.

```bash
saifctl run list

1 run(s):

  RUN_ID   FEATURE      STATUS     STARTED                   UPDATED
  eed5lz6  add-login    failed     2026-03-24T23:55:15.955Z  2026-03-25T11:10:35.904Z
```

Run ID also appears after `feat run` / `run start`:

```bash
saifctl feat run -n add-login

...

Resume again with:
  saifctl run start eed5lz6
```

## 1. Create a rule

Rules behave similarly to `AGENTS.md` - the contents are injected into the agent's prompt.

To create a rule, use `run rules create` with **either** `--content` **or** `--content-file`.

```bash
saifctl run rules create eed5lz6 --content "Use the shared validateEmail() in lib/email.ts; do not add a second validator."
```

**Longer text from a file:**

```bash
saifctl run rules create eed5lz6 --content-file ./notes/agent-feedback.md
```

On success you get a line like:

```text
Created rule a1b2c3 on run eed5lz6 (once).
```

## 2. Persistent rules

By default, a rule is only applied to the next coding round. Think of it like correcting agent's mistake - you point out the mistake, but once the agent fixes it, the rule is no longer needed.

To make it persistent, use `--scope always`. (See [Run rules](../runs.md#run-rules-user-feedback))

**Same instruction every coding round** until you delete it:

```bash
saifctl run rules create <runId> --content "Do not touch vendor/." --scope always
```

## 3. (Optional) Change or delete a rule

Whether **during** a live coding session or **before** resume — you can modify, delete, or add rules. [See full CLI reference](../commands/run-rules.md).

We'll do a quick sanity check of the rules we have on the run:

```bash
saifctl run rules list eed5lz6

2 rule(s) (2 active in next prompt):

  ID      SCOPE    CONSUMED  CONTENT                                                 
  562bd7  once     no        Use the shared validateEmail() in lib/email.ts; ...
  040eb8  always   no        Do not touch vendor/.
```

## 4. Resume

Finally, once our rules are in place, we can resume the Run:

```bash
saifctl run start eed5lz6
```

The agent continues from the saved run with your new text in the task.

The agent's prompt will now include your rules:

```text
## Plan

...

## Specification

...

## User feedback

- Use the shared validateEmail() in lib/email.ts; do not add a second validator.
- Do not touch vendor/.
```

## If something goes wrong

| Issue | What to do |
| ----- | ---------- |
| Stale / revision mismatch | Something else updated that run. Run `run rules list` or `run info`, then retry `create` / `update` / `remove`. |
| Content flag error | Use only one of `--content` or `--content-file`. |

## Recap

`run list` → Run ID → `run rules create` → `run start`

## See also

- [`run rules`](../commands/run-rules.md) · [`run start`](../commands/run-start.md) · [Runs — Run rules](../runs.md#run-rules-user-feedback)  
- [Fix agent mistakes: inspect, then run start](inspect-and-start.md)  
- [Usage](../usage.md) · [Troubleshooting](../troubleshooting.md)

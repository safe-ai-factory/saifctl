# Guides

Step-by-step walkthroughs for using SaifCTL day to day. These complement the [command reference](../commands/README.md) and the pipeline overview in [Usage](../usage.md).

<!-- 
## Happy path (coming later)

More guides can slot in here—for example: first feature end-to-end, reading run output, or opening a PR after a green run. Link them in order so new users can follow a path from init → design → run → ship. -->

## When things go wrong

| Guide | Use it when… |
| ----- | ------------ |
| [Fix agent mistakes: inspect, then run start](inspect-and-start.md) | The coding agent is wrong, stuck on an error, or you need to patch the sandbox by hand and then let the agent continue with `run start`. |
| [Live user feedback to the agent](providing-user-feedback.md) | Steer via **run rules** — Instructions appear in the task prompt. |

## Reference links

- [Usage](../usage.md) — Full pipeline diagram and stages
- [Runs](../runs.md) — What gets saved, storage backends, resume overview
- [Commands](../commands/README.md) — All CLI subcommands

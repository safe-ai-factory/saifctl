# Codebase Indexers

**Codebase indexers** give the factory's AI agents deep, accurate knowledge of your repository before they write specs or tests. Instead of guessing how your project is structured, agents query a semantic index to find existing patterns, components, and file locations.

---

## Why use an indexer?

Without an indexer, the Architect Agent writes generic specs:

> "Create a database model for users."

With an indexer, it writes grounded, specific specs:

> "Extend the existing `User` model in `src/db/schema.prisma` and wire it through the `prismaClient` exported from `src/db/index.ts`."

One of those produces drifting, hallucinated code. The other ships.

The indexer improves the quality of the specs, which in turn improves the quality of the tests and the agents output.

---

## Choosing an indexer

Use `--indexer <id>`:

```bash
saifctl init --indexer shotgun
```

| ID                        | Name                | Project URL                                   |
| ------------------------- | ------------------- | --------------------------------------------- |
| [`shotgun`](./shotgun.md) | Shotgun _(default)_ | [Link](https://github.com/shotgun-sh/shotgun) |

---

## How to use it

The indexer appears in two places in the workflow.

### 1. Build the index — `saifctl init`

At the beginning, when the codebase is indexed:

```bash
saifctl init
# or explicitly:
saifctl init --indexer shotgun
```

This parses your repository and builds a semantic graph the agents can query.

### 2. Connect to index when generating specs and tests — `feat design`

The indexer is used automatically when you run `feat design`:

```bash
saifctl feat design
# or explicitly:
saifctl feat design --indexer shotgun
```

The Architect and tests-writing agents query the index as they write specs and tests, grounding every decision in your actual codebase.

### Disabling the indexer

Pass `--indexer none` to skip the indexer entirely — useful for quick runs or when the index hasn't been built yet:

```bash
saifctl feat design --indexer none
```

---

## The `--project` flag

Indexers use the project name the database ID!

The ID ties the index built during `saifctl init` to the index queried during `saifctl feat design`.

Make sure to use the same project name when building and querying the index:

```bash
saifctl init
saifctl feat design
```

Project name defaults to the `name` field in your `package.json`.

Override project name with `-p / --project` when you have multiple indexed codebases or no `package.json`:

```bash
saifctl init --project my-app
saifctl feat design --project my-app
```

---

## See Also

- [Shotgun indexer](./shotgun.md)
- [Commands reference](../commands/README.md)
- [Environment variables](../env-vars.md)

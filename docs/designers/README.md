# Spec Designers

**Spec designers** turn your feature proposal into a full, production-ready spec before any agent writes a line of code. Instead of handing a vague prompt to a coding agent and hoping for the best, a designer researches your codebase, reasons about the change, and produces structured output the agents can act on reliably.

---

## Why use a designer?

Without a designer, you hand a feature prompt directly to a coding agent:

> "Add user login."

The agent guesses. It invents a database schema that doesn't match yours, imports a library you're not using, and structures the code in a way that breaks your existing conventions. You review 400 lines of drift and patch it by hand.

With a designer, a dedicated research-and-spec agent runs first.

**What files designers produce?**

- `plan.md` — Implementation steps grounded in your existing patterns
- `specification.md` — Precise behavior contract the agent must satisfy
- `research.md` — Codebase findings that informed the spec
- `tasks.md` — Broken-down work items, ready to hand to the coding agent

The coding agent sees a grounded spec, not a one-liner. It ships better code on the first attempt.

---

## Choosing a designer

Use `--designer <id>` with `saifctl feat design`:

```bash
saifctl feat design --designer shotgun
```

| ID                        | Name                | Project URL                                   |
| ------------------------- | ------------------- | --------------------------------------------- |
| [`shotgun`](./shotgun.md) | Shotgun _(default)_ | [Link](https://github.com/shotgun-sh/shotgun) |

---

## How to use it

The designer runs as part of `saifctl feat design`.

### 1. Create a proposal

```bash
saifctl feat new
```

Edit `saifctl/features/add-login/proposal.md` with what you want to build. One paragraph is enough — the designer figures out the rest.

### 2. Run spec generation — `saifctl feat design`

```bash
saifctl feat design
# or explicitly:
saifctl feat design --designer shotgun
```

The designer reads your `proposal.md`, researches the codebase (via the active indexer), and writes the 4 spec files into `saifctl/features/add-login/`.

If the spec files already exist, the CLI asks whether to redo them — so re-running is always safe. Use `-y`/`--yes` with `--name` to skip the prompt and assume redo (non-interactive mode).

### 3. Choose a model — `--model`

Pass `--model` to override the LLM the designer uses:

```bash
saifctl feat design --model claude-opus-4-5
```

### 4. Disable the designer

Pass `--designer none` to skip spec generation entirely and jump straight to tests generation — useful when you've already written your spec files manually:

```bash
saifctl feat design --designer none
```

---

## Designer and indexer: how they work together

The designer and indexer are complementary — they both run during `saifctl feat design`, but they do different things.

The designer uses the indexer to ground its spec in real code.

| Who        | Indexer                                                                        | Designer                                                 |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **What**   | Parses your repo into a semantic graph                                         | Researches your codebase and writes the spec             |
| **When**   | Runs at `saifctl init` (build index)<br/>and `saifctl feat design` (query index) | Runs at `saifctl feat design`                             |
| **Output** | A queryable codebase index                                                     | `plan.md`, `specification.md`, `research.md`, `tasks.md` |
| **Flag**   | `--indexer`                                                                    | `--designer`                                             |

---

## See Also

- [Shotgun designer](./shotgun.md)
- [Codebase Indexers](../indexer/README.md)
- [Commands reference](../commands/README.md)
- [Environment variables](../env-vars.md)

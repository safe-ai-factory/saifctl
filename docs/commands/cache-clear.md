# saif cache clear

Remove sandbox entries for this project (--all: everything).

Deletes factory sandbox entries from `/tmp/factory-sandbox/` (or a custom path). By default removes only entries for the current project (from `package.json` name). Use `--all` to remove entries for all projects.

## Usage

```bash
saif cache clear [options]
```

## Arguments

| Argument             | Alias | Type    | Description                                              |
| -------------------- | ----- | ------- | -------------------------------------------------------- |
| `--all`              | —     | boolean | Remove entries for all projects                          |
| `--project`          | `-p`  | string  | Project name override (default: `package.json`)          |
| `--sandbox-base-dir` | —     | string  | Sandbox base directory (default: `/tmp/factory-sandbox`) |

## Examples

Remove sandbox entries for the current project:

```bash
saif cache clear
```

Remove sandbox entries for all projects:

```bash
saif cache clear --all
```

Remove sandbox entries or specific project:

```bash
saif cache clear -p my-project
```

Use a custom sandbox base directory:

```bash
saif cache clear --sandbox-base-dir /var/cache/factory
```

## What it does

1. Resolves the sandbox base dir (default: `/tmp/factory-sandbox`)
2. If `--all`: removes all entries in the base dir
3. Otherwise: removes only entries matching `<project>-*` (project from `package.json` or `--project`)
4. Prints each removed entry path

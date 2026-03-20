# saifac cache list

List sandbox dirs in the sandbox base dir for this project.

Shows factory sandbox entries in `/tmp/saifac/` (or a custom path). By default lists only entries for the current project (from `package.json` name). Use `--all` to list entries for all projects.

## Usage

```bash
saifac cache list [options]
```

## Arguments

| Argument             | Alias | Type    | Description                                              |
| -------------------- | ----- | ------- | -------------------------------------------------------- |
| `--all`              | —     | boolean | List entries for all projects                            |
| `--project`          | `-p`  | string  | Project name override (default: `package.json`)          |
| `--sandbox-base-dir` | —     | string  | Sandbox base directory (default: `/tmp/saifac`) |

## Examples

List sandbox dirs for the current project:

```bash
saifac cache list
```

List sandbox dirs for all projects:

```bash
saifac cache list --all
```

Show sandbox dirs for specific project name:

```bash
saifac cache list -p my-project
```

Use a custom sandbox base directory:

```bash
saifac cache list --sandbox-base-dir /var/cache/factory
```

## What it does

1. Resolves the sandbox base dir (default: `/tmp/saifac`)
2. If `--all`: lists all entries in the base dir
3. Otherwise: filters entries matching `<project>-*` (project from `package.json` or `--project`)
4. Prints each matching entry path

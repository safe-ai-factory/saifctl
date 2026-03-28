# Agent environment variables and secrets

Saifctl injects extra variables into the **coding agent container** in two categories:

- **Public environment** — normal `KEY=value` settings. The merged map is persisted with the run when run storage is enabled.
- **Secrets** — sensitive values are never written into the run artifact. Saifctl stores **variable names** and/or **paths to secret files**; values are read from the host when the container starts.

Model and reviewer API keys are injected separately. Do not pass them through `--agent-env`.

## Public vs secrets

| Category | Typical use | Values in run storage? |
| -------- | ----------- | ---------------------- |
| **Public** | Feature flags, non-sensitive URLs, defaults | **Yes** — full merged map |
| **Secrets** | API keys, tokens | **No** — names and/or file paths only |

## Public environment variables

### Sources (lowest → highest precedence)

When the same key appears in more than one place, **later** sources win:

1. `environments.coding.agentEnvironment` in `saifctl/config.*`
2. `defaults.agentEnv` in `saifctl/config.*`
3. `--agent-env-file` — one path or comma-separated paths; `.env`-style `KEY=value` lines; **later files override earlier** keys on duplicates
4. `--agent-env` — `KEY=value`; repeatable flag or comma-separated pairs (**values cannot contain commas**)

### Reserved keys

Variables whose names start with `SAIFCTL_`, plus factory-controlled LLM and reviewer keys, are **ignored** with a warning. Configure models and endpoints with the normal Saifctl CLI options and config fields.

## Secrets

### Host environment (names only)

`--agent-secret` takes **variable names** only (repeatable or comma-separated). Values are copied from **`process.env` on the host** when Saifctl builds the container.

You can also list default names in `defaults.agentSecretKeys` in config. If a name is missing or empty on the host, it is skipped (with a warning).

### Secret files

`--agent-secret-file` uses the same path rules as `--agent-env-file` (comma-separated paths, `.env`-style lines). The run artifact stores the **paths**, not the file contents, so **resume** re-reads files from disk (paths are resolved relative to the project directory).

### Precedence when keys overlap

- **File vs host-named:** For the same key, the **host-named** value (from `--agent-secret` / `defaults.agentSecretKeys`) wins over the value from a secret file.
- **Duplicate names** in `defaults.agentSecretKeys` and `--agent-secret`: **last occurrence wins** (same idea as public env).

## Persistence and resume

| Data | On resume |
| ---- | --------- |
| Merged **public** `agentEnv` | Loaded from the saved run; optional `run start` flags can override where supported |
| **Secret file** paths | Stored on the artifact; files are **read again** from the project directory |
| **Name-only** secrets | Values read **again** from the host environment each start/resume (CI must export the same names) |

## Examples

**Public vars on the CLI:**

```bash
saifctl feat run -n my-feature \
  --agent-env "LOG_LEVEL=debug,FEATURE_FLAG_X=1"
```

**Public vars from a file** (`saifctl/agent.public.env`):

```text
LOG_LEVEL=info
PUBLIC_API_BASE=https://api.example.com
```

```bash
saifctl feat run -n my-feature --agent-env-file saifctl/agent.public.env
```

**Secret from the host** (only the name appears on the command line):

```bash
export ACME_API_TOKEN="…"
saifctl feat run -n my-feature --agent-secret ACME_API_TOKEN
```

**Secret file** (`saifctl/agent.secrets.env` — keep out of version control, e.g. `.gitignore`):

```text
# KEY=value like .env
ACME_API_TOKEN=sk-…
```

```bash
saifctl feat run -n my-feature --agent-secret-file saifctl/agent.secrets.env
```

**Combined** (later public sources override earlier ones for duplicate keys):

```bash
export ACME_API_TOKEN="…"
saifctl feat run -n my-feature \
  --agent-env-file saifctl/base.env,saifctl/local.env \
  --agent-env "LOG_LEVEL=debug" \
  --agent-secret ACME_API_TOKEN \
  --agent-secret-file saifctl/agent.secrets.env
```

**Defaults in `saifctl/config.json`** (use `agentSecretKeys` for tokens, not `agentEnv`):

```json
{
  "defaults": {
    "agentEnv": {
      "LOG_LEVEL": "info"
    },
    "agentSecretKeys": ["ACME_API_TOKEN"]
  }
}
```

`feat run` and `run start` share the same `--agent-env*`, `--agent-secret*`, and related options where applicable; see `saifctl feat run --help` and `saifctl run start --help`.

## Related documentation

- [Environment variables](env-vars.md) - LLM keys, Git tokens, and factory-injected container vars
- [Configuration](config.md) - `saifctl/config.*` structure and all `defaults` / `environments` fields
- [`feat run`](commands/feat-run.md) - start new run
- [`run start`](commands/run-start.md) - resuming with stored state
- [Runs](runs.md) - artifacts, storage backends
- [Usage](usage.md) · [Troubleshooting](troubleshooting.md)

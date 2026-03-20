# Test profiles: Configure testing containers

By default tests run in a NodeJS container with Vitest.

You can pick and switch between languages and frameworks using **test profiles**.

You don't need to build anything. The factory ships pre-built test runner images for Node, Python, Go, and Rust.

## What is a test profile?

A **test profile** is a language and framework combination (e.g. TypeScript + Vitest, Python + pytest) that the factory uses in two places:

1. **Test generation** — When the factory generates tests for your feature (`saifac feat design`), the profile determines in what language the code gets generated.

   For example, `node-vitest` produces `*.spec.ts` files with Vitest; `python-pytest` produces `test_*.py` files with pytest.

2. **Test execution** — When you run the coding agent (`saifac feat run`), the profile selects the Docker image that runs your tests.

   Each profile has its own pre-built image with the right runtime and tooling.

Use `--test-profile` to pick a profile. The default is `node-vitest`.

The profile must match on both generation and execution. If you ran `saifac feat design` with `python-pytest`, use the same profile for `saifac feat run` too.

---

## Generating tests

Run `saifac feat design` to let AI agent write tests for your feature:

```bash
saifac feat design --test-profile python-pytest
```

Docker pulls the test runner image from GHCR. Nothing to configure. No `docker build` needed for default images.

### Example: Python/pytest

With `--test-profile python-pytest`, you get the following layout:

```
saifac/features/my-feature/
└── tests/
    ├── tests.json
    ├── tests.md
    ├── helpers.py
    ├── test_infra.py
    ├── public/
    │   ├── test_content_structure.py
    │   └── test_auth_flow.py
    └── hidden/
        ├── test_error_handling.py
        └── test_negative_cases.py
```

**Example spec file** (`public/test_content_structure.py`):

```py
import re
import pytest

from ..helpers import exec_sidecar

class TestDummyMdContentStructure:
    def test_tc_dummy2_002_presence_of_the_correct_h1_title(self):
        result = exec_sidecar("cat", ["dummy.md"])
        assert result.exit_code == 0, f"Failed to read dummy.md: {result.stderr}"
        assert "# Dummy" in result.stdout

    def test_tc_dummy2_003_presence_of_the_purpose_section(self):
        result = exec_sidecar("cat", ["dummy.md"])
        assert result.exit_code == 0, f"Failed to read dummy.md: {result.stderr}"
        assert re.search(r"#+\s+Purpose", result.stdout, re.IGNORECASE)
```

### Example: TypeScript/Vitest

For comparison, this is the project layout for a TypeScript project:

```
saifac/features/my-feature/
└── tests/
    ├── tests.json
    ├── tests.md
    ├── helpers.ts
    ├── infra.spec.ts
    ├── public/
    │   ├── content-structure.spec.ts
    │   └── auth-flow.spec.ts
    └── hidden/
        ├── error-handling.spec.ts
        └── negative-cases.spec.ts
```

**Example spec file** (`public/content-structure.spec.ts`):

```ts
/* eslint-disable */
// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { execSidecar } from '../helpers.js';

describe('dummy.md Content Structure', () => {
  it('tc-dummy2-002: Presence of the correct H1 title', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);

    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    expect(stdout).toContain('# Dummy');
  });

  it('tc-dummy2-003: Presence of the Purpose section', async () => {
    const { stdout, stderr, exitCode } = await execSidecar('cat', ['dummy.md']);

    expect(exitCode, `Failed to read dummy.md: ${stderr}`).toBe(0);
    expect(stdout).toMatch(/#+\s+Purpose/i);
  });
});
```

## Available profiles

Agent's code is **unsafe**, so we test it over HTTP.

To make it easier, each language language (Node, Python, Go, Rust) offers both Playwright and non-Playwright profiles:

```bash
# TypeScript + Vitest
saifac feat run --test-profile node-vitest

# TypeScript + Playwright
saifac feat run --test-profile node-playwright

# Python + Pytest
saifac feat run --test-profile python-pytest

# Python + Playwright
saifac feat run --test-profile python-playwright

...
```

Each profile has its own image. They're all pre-built and pulled automatically.

| Profile             | Language + framework          | URL                                                               |
| ------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `node-vitest`       | TypeScript + Vitest (default) | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-node-vitest       |
| `node-playwright`   | TypeScript + Playwright       | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-node-playwright   |
| `python-pytest`     | Python + pytest               | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-python-pytest     |
| `python-playwright` | Python + Playwright           | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-python-playwright |
| `go-gotest`         | Go + gotest                   | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-go-gotest         |
| `go-playwright`     | Go + Playwright               | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-go-playwright     |
| `rust-rusttest`     | Rust + cargo test             | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-rust-rusttest     |
| `rust-playwright`   | Rust + Playwright             | ghcr.io/JuroOravec/safe-ai-factory/saifac-test-rust-playwright   |

Use `--test-profile python-pytest` or `--test-image <url>` to switch.

## Pin to a release (optional)

To lock to a specific version instead of `latest`:

```bash
saifac feat run --test-image ghcr.io/JuroOravec/safe-ai-factory/saifac-test-node-vitest:v1.0.0
```

Images are tagged with each release (e.g. `v1.0.0`). Use `:latest` for the bleeding edge.

---

## Changing profiles

If you already ran `saifac feat design` with one profile (e.g. `node-vitest`) and then switch to another (e.g. `python-pytest`), you must re-run `saifac feat design` with `--force` flag to regenerate the test scaffold.

That will overwrite existing test files, so back up any custom edits first.

```sh
saifac feat design --test-profile python-pytest --force
```

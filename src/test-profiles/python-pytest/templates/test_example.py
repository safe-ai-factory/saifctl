"""
Example test — a runnable starting point you EDIT IN PLACE.

Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
design-tests`. Unlike helpers.py / test_infra.py, this file is meant to be
edited: keep it as a working reference for the pytest format, or replace
its body with your real assertion. The scaffold skips this file when it
already exists; pass `--force` to overwrite.

What this demonstrates:
  - Importing the shared transport from `.helpers`
  - Calling `exec_sidecar(cmd, args)` to run a command in the staging container
  - Asserting on `exit_code` and `stdout`

Why it passes by default: every saifctl staging container ships a sidecar
that exposes the workspace shell, and `echo example-ok` is reliably present.
Replace this with whatever invariant you actually want gated.
"""

from .helpers import exec_sidecar


class TestExample:
    def test_runs_a_noop_in_the_staging_container(self) -> None:
        result = exec_sidecar("echo", ["example-ok"])
        assert result.exit_code == 0, f"staging echo failed: {result.stderr}"
        assert result.stdout.strip() == "example-ok"

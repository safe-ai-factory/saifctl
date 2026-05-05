"""
Example test — a runnable starting point you EDIT IN PLACE.

Scaffolded by `saifctl init`, `saifctl init tests`, or `saifctl feat
design-tests`. Unlike helpers.py / test_infra.py, this file is meant to be
edited: keep it as a working reference for the pytest-playwright format, or
replace its body with your real assertion. The scaffold skips this file
when it already exists; pass `--force` to overwrite.

What this demonstrates:
  - Importing `base_url` from `.helpers`
  - Hitting the staging app via the pytest-playwright `page` fixture
  - Asserting on response status

If your project doesn't expose an HTTP service in the staging container,
delete this file and use `exec_sidecar` from helpers.py instead (CLI-style
checks, like the python-pytest example).
"""

from playwright.sync_api import Page

from .helpers import base_url


class TestExample:
    def test_staging_app_responds_at_root(self, page: Page) -> None:
        response = page.goto(base_url())
        assert response is not None, "staging app not reachable (page.goto returned None)"
        assert response.status < 400, f"expected 2xx/3xx, got {response.status}"

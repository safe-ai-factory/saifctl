# Phase 01 — Validate input

Parse an input array of records and reject malformed ones. A record is
malformed if any of:

- it isn't an object,
- `id` is missing or not a string,
- `value` is missing or not a finite number.

Valid records pass through unchanged. Malformed records throw with a message
that names the offending field — no silent skips, no `try/catch` swallowing.

## Tests

A production version of this phase would put assertions under
`phases/01-validate-input/tests/` covering:

- happy path (well-formed records pass),
- each invalid-shape variant individually,
- error message names the field.

This doc-only example does **not** ship that directory — the prompt
shape is the focus, not the test execution.

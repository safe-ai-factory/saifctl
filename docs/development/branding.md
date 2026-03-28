# Branding: SaifCTL / `saifctl`

This document fixes how we write the CLI name across the repo: **display name** vs **typed command**.

## Display name (product / marketing)

Use **SaifCTL** when the name appears as a **proper noun** for the tool or product:

- Landing page headlines and hero copy
- Prose in docs when referring to “the tool” rather than a shell invocation

Do **not** use **SAIFCTL** in user-facing text. All-caps reads as shouting and does not match common patterns for `*ctl` tools.

## CLI (binary and shell examples)

Use **`saifctl`** (all lowercase) for:

- The published binary name
- Shell examples, install instructions, and any place the user types the command

```bash
saifctl run start
saifctl run inspect
```

## Documentation

| Situation | Format |
|-----------|--------|
| Sentences about the product (“SaifCTL helps you …”) | **SaifCTL** |
| Inline code, paths, flags, or anything the user runs | `` `saifctl` `` |

Example: *SaifCTL* is documented here; use `saifctl run start` to launch a run.

## Rationale

- Lowercase matches Unix convention for executables and matches what people type.
- **SaifCTL** signals a kubectl-style control tool without renaming the binary.
- Splitting display vs CLI avoids awkward typography (e.g. “SaifCTL” in a `$` prompt block).

When in doubt: **headlines and prose → SaifCTL; commands and backticks → `saifctl`.**

# npm tombstone packages

Defensive placeholder packages so unscoped names cannot be squatted on npm:

- **`safe-ai-factory`** and **`saifctl`** — real CLI is **`@safe-ai-factory/saifctl`**.
- **`saifdocs`** — real package is **`@safe-ai-factory/saifdocs`**.

Each tombstone has **no useful runtime** (requiring it throws). Do not add a `bin` field to tombstones.

## SaifCTL: publish order

1. **`@safe-ai-factory/saifctl`** — from the **safe-ai-factory** repository root (real package).
2. **`safe-ai-factory`** — from `npm-tombstones/safe-ai-factory/`.
3. **`saifctl`** — from `npm-tombstones/saifctl/`.

After each tombstone publish, run **`npm deprecate`** so installers see a warning.

## Commands (copy-paste)

Log in once:

```bash
npm login
```

### 1. Real package: SaifCTL (repository root)

From **`safe-ai-factory/`** (this repo root). The canonical publish flow
(per Decision D-11) is to build a verified tarball locally, then publish
it bit-identically:

```bash
cd /path/to/safe-ai-factory
pnpm install --frozen-lockfile
pnpm run check         # tests, lint, validate
bash scripts/package.sh  # builds + npm pack into dist-pack/
npm publish dist-pack/safe-ai-factory-saifctl-*.tgz --access public
```

The same flow is what `.github/workflows/publish-npm.yml` runs in CI on
a `v*` tag — what you verify locally is bit-identical to what ships.
(`prepublishOnly` was dropped; the script handles the build step
explicitly.)

### 2. Tombstone: `safe-ai-factory`

```bash
cd /path/to/safe-ai-factory/npm-tombstones/safe-ai-factory
npm publish
npm deprecate safe-ai-factory@1.0.0 "This name is not the SaifCTL CLI. Install @safe-ai-factory/saifctl instead."
```

(Use `npm deprecate safe-ai-factory@"*"` if you prefer all versions.)

### 3. Tombstone: `saifctl`

```bash
cd /path/to/safe-ai-factory/npm-tombstones/saifctl
npm publish
npm deprecate saifctl@1.0.0 "Official package is @safe-ai-factory/saifctl. Install that instead."
```

### 4. Real package: `@safe-ai-factory/saifdocs`

From the **saifdocs** repo root, after `pnpm run check` succeeds:

```bash
cd /path/to/saifdocs
pnpm install --frozen-lockfile
pnpm run check
npm publish --access public
```

Use your release process (e.g. Git tag + `publish-npm` workflow) if you publish from CI.

### 5. Tombstone: `saifdocs`

Run only after **`@safe-ai-factory/saifdocs`** exists on npm.

```bash
cd /path/to/safe-ai-factory/npm-tombstones/saifdocs
npm publish
npm deprecate saifdocs@1.0.0 "Official package is @safe-ai-factory/saifdocs. Install that instead."
```

(Use `npm deprecate saifdocs@"*"` if you prefer all versions.)

## Version bumps

- Bump **`npm-tombstones/*/package.json`** `version` if you need to re-publish a tombstone (npm rejects duplicate versions).
- The main SaifCTL app version lives in the **safe-ai-factory** root **`package.json`**.

# Vendor workspace

## Argus (`vendor/argus`) — git submodule

The Argus fork is tracked as a **git submodule** pointing at:

**<https://github.com/safe-ai-factory/argus>** (`branch = main`)

Upstream: [Meru143/argus](https://github.com/Meru143/argus) (npm: `argus-ai`)

### Clone this repo

```bash
git clone --recurse-submodules <YOUR_SAFE_AI_FACTORY_REMOTE>
cd safe-ai-factory
```

If you cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### Work inside the submodule

```bash
cd vendor/argus
git status
git fetch upstream   # add upstream if missing: git remote add upstream https://github.com/Meru143/argus.git
# … make changes, commit on the fork …
git push origin main
```

Pin the submodule to a new commit in **safe-ai-factory**:

```bash
cd vendor/argus && git pull origin main && cd ../..
git add vendor/argus
git commit -m "chore(vendor): bump argus submodule"
```

### Fork: disable crates.io + npm from release-plz

The workflow stays mergeable with upstream. On **safe-ai-factory/argus**, set a **GitHub Actions repository variable**:

- **Name:** `ARGUS_PUBLISH_TO_REGISTRIES`
- **Value:** `false`

(Settings → Secrets and variables → Actions → **Variables**.)

When unset (upstream), behavior is unchanged: `release-plz release`, conditional release PR, and npm publish when `argus-ai` ships.

The upstream repo's CI was not attaching binaries to releases. The fork fixes that.
SAIF downloads the **musl** Argus binary for the current architecture on first use and caches it under
**`/tmp/saifctl/bin/`** as e.g. **`argus-linux-amd64-musl-v0.5.6`** (semver in the filename; not in the repo).
Override with **`SAIF_REVIEWER_BIN_DIR`** if needed.
The binary version is pinned via **`ARGUS_VERSION`** in `src/orchestrator/sidecars/reviewer/argus.ts`.

> **Why musl?** The coder containers are based on Debian Bookworm (GLIBC 2.36). The `*-unknown-linux-gnu`
> binaries built on modern Ubuntu/GitHub Actions runners require GLIBC 2.39+, causing a
> `version 'GLIBC_2.39' not found` crash at runtime. musl binaries are statically linked
> against musl libc and have **no GLIBC dependency**, so they run on any Linux regardless of
> the container's libc version.

### Force a fork release (manual cut)

The fork's `release.yml` triggers on **`argus-core-v*`** tags (matching upstream's release-plz convention). The release job uses `softprops/action-gh-release@v2`, which creates the GitHub Release as part of the workflow — no need to pre-create one.

1. **Submodule:** `cd vendor/argus`
2. **(Only if bumping)** update **`[workspace.package].version`** in `Cargo.toml`, every **`version = "…"`** in `[workspace.dependencies]`, and `npm/package.json`'s **`"version"`** to the new semver. Commit + push to `main`.
3. **Tag and push.** Workflow fires on the tag push, runs the 7-platform matrix (including the 2 musl targets), then creates a GitHub Release at the tag with the archives attached:

   ```bash
   VERSION=0.5.6   # match Cargo.toml's workspace.package.version
   git tag argus-core-v${VERSION}
   git push origin argus-core-v${VERSION}
   ```

4. Wait for Actions to finish (~10–15 min for the 7-target matrix). Verify the release at `https://github.com/safe-ai-factory/argus/releases/tag/argus-core-v${VERSION}` has all 7 archives.

5. **Update `ARGUS_VERSION`** in `src/orchestrator/sidecars/reviewer/argus.ts` to the new semver and commit. saifctl will download from `https://github.com/safe-ai-factory/argus/releases/download/argus-core-v${ARGUS_VERSION}/argus-x86_64-unknown-linux-musl.tar.gz` (or the equivalent aarch64 asset).

   Optionally refresh the `vendor/argus` submodule pointer in saifctl: `git add vendor/argus && git commit -m "chore(vendor): bump argus submodule to v${VERSION}"`.

### Updating the binaries (new upstream version)

1. **Sync upstream changes into the fork (in the submodule):**

   ```bash
   cd vendor/argus
   git fetch upstream
   git merge upstream/main    # or rebase
   git push origin main
   ```

2. **Tag a new release on the fork** (triggers the binary build CI). Same flow as above:

   ```bash
   VERSION=0.5.7   # match Cargo.toml after the upstream sync
   git tag argus-core-v${VERSION}
   git push origin argus-core-v${VERSION}
   ```

   Wait ~10–15 min for the 7-platform build matrix (including musl targets) to finish and attach assets.

3. **Update `ARGUS_VERSION`** in `src/orchestrator/sidecars/reviewer/argus.ts` to the new version and commit:

   ```bash
   # edit ARGUS_VERSION in argus.ts
   git add src/orchestrator/sidecars/reviewer/argus.ts
   git commit -m "chore(reviewer): pin argus to v${VERSION}"
   ```

   SAIF will download the matching binary on the next run (cached under `/tmp/saifctl/bin/` with the version in the filename).

Optionally bump the submodule pointer after syncing the fork:

```bash
git add vendor/argus
git commit -m "chore(vendor): bump argus submodule to v${VERSION}"
```

---

## Leash (`vendor/leash`) — git submodule (temporary workaround)

The Leash fork is tracked as a **git submodule** pointing at:

**<https://github.com/JuroOravec/leash>** (`branch = workaround/h2patch-image`)

Upstream: [strongdm/leash](https://github.com/strongdm/leash) (npm: `@strongdm/leash`)

> **This submodule is a temporary workaround.** The upstream Leash MITM proxy does not support
> HTTP/2 — clients that negotiate HTTP/2 via ALPN (e.g. the Cursor CLI, gRPC tools) fail with
> "malformed HTTP request/response" errors inside sandboxed containers. The fix is submitted
> upstream at [strongdm/leash#71](https://github.com/strongdm/leash/pull/71).
> Tracked locally at [#73](https://github.com/safe-ai-factory/saifctl/issues/73).
>
> Once the upstream PR merges and a new `@strongdm/leash` npm release ships a fixed Docker image,
> follow the **Removal** steps below.

### What this submodule is used for

The submodule itself is **not imported as Go source**. It contains only `Dockerfile.h2patch`,
which was used to build a patched Leash Docker image and push it to GHCR:

```bash
cd vendor/leash
docker buildx build --platform linux/arm64,linux/amd64 --push \
  -f Dockerfile.h2patch \
  -t ghcr.io/jurooravec/leash:h2patch-6ca7cf9 \
  -t ghcr.io/jurooravec/leash:latest-h2patch \
  .
```

The image is then used as the default Leash daemon image via `DEFAULT_LEASH_IMAGE` in
`src/constants.ts`, which saifctl injects as `LEASH_IMAGE` when spawning Leash (unless the user
has already set `LEASH_IMAGE` themselves).

### Clone this repo

```bash
git clone --recurse-submodules <YOUR_SAFE_AI_FACTORY_REMOTE>
cd safe-ai-factory
```

If you cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### Rebuilding the image (e.g. after syncing upstream commits)

```bash
cd vendor/leash

# Sync the upstream fix branch into our fork
git fetch origin
git checkout workaround/h2patch-image

# Rebuild and push (replace SHA tag with the new HEAD short SHA)
SHA=$(git rev-parse --short HEAD)
docker buildx build --platform linux/arm64,linux/amd64 --push \
  -f Dockerfile.h2patch \
  -t ghcr.io/jurooravec/leash:h2patch-${SHA} \
  -t ghcr.io/jurooravec/leash:latest-h2patch \
  .
```

Then update the pinned SHA tag in `src/constants.ts` (`DEFAULT_LEASH_IMAGE`) and bump the
submodule pointer:

```bash
cd ../..
git add vendor/leash src/constants.ts
git commit -m "chore(vendor): rebuild leash HTTP/2 workaround image (${SHA})"
```

### Removal (once strongdm/leash#71 is merged and shipped)

1. Delete `DEFAULT_LEASH_IMAGE` from `src/constants.ts`.
2. Delete the `WORKAROUND(leash-http2)` block and its `DEFAULT_LEASH_IMAGE` import from
   `src/engines/docker/index.ts`.
3. Run:
   ```bash
   git submodule deinit vendor/leash
   git rm vendor/leash
   ```
4. Remove the `[submodule "vendor/leash"]` entry from `.gitmodules`.
5. Bump `@strongdm/leash` in `package.json` to the version that includes the fix.
6. Close [#73](https://github.com/safe-ai-factory/saifctl/issues/73).

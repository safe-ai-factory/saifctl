# Deploying the SaifCTL Website to GitHub Pages

This document describes how the website is deployed to GitHub Pages and what you need to configure.

## Overview

The site is a Next.js app that is statically exported and deployed via GitHub Actions. Every push to `main` triggers a build and deploy. The site is served at:

**`https://<owner>.github.io/safe-ai-factory/`**

## GitHub Repository Configuration

### 1. Enable GitHub Pages

1. Go to your repository on GitHub.
2. Navigate to **Settings** → **Pages**.
3. Under **Build and deployment** → **Source**, select **GitHub Actions** (not "Deploy from a branch").

That's all. The workflow handles the rest.

## How It Works

### Next.js Static Export

GitHub Pages serves static HTML, CSS, and JavaScript. Next.js is configured for static export in `web/next.config.ts`:

- **`output: 'export'`** — Produces a static site in the `out/` directory instead of a Node.js app.
- **`images: { unoptimized: true }`** — Disables the Image Optimization API (no server required).
- **`basePath: '/safe-ai-factory'`** — All asset URLs and routes are prefixed with `/safe-ai-factory` so they resolve correctly when the site is served from `owner.github.io/safe-ai-factory/`.
- **`outputFileTracingRoot`** — Pins the workspace root to the `web/` directory to avoid monorepo lockfile confusion during build.

### Deployment Workflow

The workflow lives at `.github/workflows/publish-web.yml` (in the **safe-ai-factory** repo, not the parent agents repo).

**Triggers:**

- Push to `main`
- Manual run via **Actions** → **Deploy website to GitHub Pages** → **Run workflow**

**Build steps:**

1. Checkout the repo.
2. Setup Node.js 20 and restore npm cache.
3. Restore Next.js build cache (`.next/cache`).
4. Run `npm ci` in the `web/` directory.
5. Run `npm run build` (produces `web/out/`).
6. Upload `web/out` as the Pages artifact.
7. Deploy to GitHub Pages via `actions/deploy-pages`.

**Path convention:** Because the workflow runs in the safe-ai-factory repo, all paths are relative to the repo root. The web app lives at `web/`, so we use `working-directory: web`, `path: web/out`, etc. — not `safe-ai-factory/web`.

## Local Build

To build locally and inspect the static output:

```bash
cd web
npm ci
npm run build
```

The output will be in `web/out/`. To preview it locally:

```bash
npx serve out
```

Then open `http://localhost:3000/safe-ai-factory/` (the basePath must match in production).

## Custom Domain or Different Deployment

### Custom domain (e.g. safeaifactory.com)

If you use a custom domain pointing at GitHub Pages:

**1. Add the domain in GitHub**

- Go to **Settings** → **Pages**.
- Under **Custom domain**, enter your domain (e.g. `safeaifactory.com`).
- Click **Save**. GitHub may show "DNS check unsuccessful" initially — that's expected until your registrar propagates the records.

**2. Configure DNS at your registrar (e.g. Namecheap)**

Add these records (replace `yourusername` with your GitHub username):

| Type  | Host  | Value                     |
| ----- | ----- | ------------------------- |
| A     | `@`   | `185.199.108.153`         |
| A     | `@`   | `185.199.109.153`         |
| A     | `@`   | `185.199.110.153`         |
| A     | `@`   | `185.199.111.153`         |
| CNAME | `www` | `yourusername.github.io.` |

Remove any existing A or CNAME records for `@` or `www` (e.g. parking/redirect records).

**3. Wait for propagation**

DNS changes can take 15–60 minutes. Periodically click **Check again** in GitHub Pages settings. Once the DNS check passes, the **Enforce HTTPS** checkbox becomes available — check it to serve the site over HTTPS (certificate provisioning may take a few extra minutes).

**4. Update Next.js config and redeploy**

- In `web/next.config.ts`, set `basePath: ''` (or remove it) so assets load from the root.
- Rebuild and redeploy.

**Optional:** For IPv6 support, add AAAA records for `@` with values `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`. GitHub usernames in the CNAME value are case-insensitive.

### Different repository

If the site is deployed from a different repo (e.g. the parent `agents` repo):

1. Move or copy the workflow to that repo's `.github/workflows/`.
2. Update paths: if the web app is at `safe-ai-factory/web/`, use `working-directory: safe-ai-factory/web`, `path: safe-ai-factory/web/out`, etc.
3. Update `basePath` in `next.config.ts` to match the repo name (e.g. `/agents` for `owner.github.io/agents/`).
4. Enable GitHub Pages with **GitHub Actions** in that repo's settings.

## Troubleshooting

| Issue                                          | Cause                                  | Fix                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DNS check unsuccessful / NotServedByPagesError | Propagation delay or wrong DNS records | Verify A records resolve with `dig yourdomain.com`. If correct, wait 15–60 min and click **Check again**. Ensure no conflicting records. |
| 404 on assets (blank page, broken CSS/JS)      | Wrong `basePath`                       | Ensure `basePath` matches the Pages URL path. For `owner.github.io/safe-ai-factory/`, use `basePath: '/safe-ai-factory'`.                |
| Workflow not running                           | Pages source not set to Actions        | In **Settings** → **Pages**, set Source to **GitHub Actions**.                                                                           |
| Build fails: "Module has no exported member"   | Missing export                         | Ensure shared types (e.g. `SectionId`) are exported from their public modules (e.g. `lib/analytics/index.ts`).                           |
| Build fails: lockfile/cache confusion          | Monorepo with multiple lockfiles       | `outputFileTracingRoot` in `next.config.ts` pins the root to `web/`; keep it.                                                            |

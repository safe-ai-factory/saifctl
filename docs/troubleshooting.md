# Troubleshooting

Common setup issues when running SaifCTL on the host.

## Docker

### Error `connect ENOENT /var/run/docker.sock`

**Symptom:** Errors such as `Error: connect ENOENT /var/run/docker.sock` while **`docker info`** and **`docker ps`** work in the same terminal.

**Why:** The Docker CLI uses **contexts** (see `docker context show` and `~/.docker/config.json`). It may talk to Colima, OrbStack, or another daemon whose Unix socket is **not** at `/var/run/docker.sock`.

SaifCTL uses **dockerode**, which follows **[docker-modem](https://github.com/apocas/docker-modem)** rules: it uses the **`DOCKER_HOST`** environment variable when set, otherwise it defaults to **`/var/run/docker.sock`** on macOS/Linux. It does **not** read the CLI’s current context.

**Fix:** Set **`DOCKER_HOST`** to the same API endpoint your daemon exposes.

#### Colima

1. Confirm Colima is running and read the socket path:

   ```bash
   colima status
   ```

   Typical output includes:

   ```text
   docker socket: unix:///Users/<you>/.colima/default/docker.sock
   ```

2. Export (**use the path `colima status` prints**; profile `default` is shown above):

   ```bash
   export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
   ```

   Or the fully expanded form:

   ```bash
   export DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock
   ```

   If you use a non-default profile (`colima start --profile foo`), the directory is `~/.colima/<profile>/docker.sock`.

3. **Persist** in your shell profile or project **`.env`** (if you load env from there):

   ```bash
   DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock
   ```

After this, restart the terminal or reload env and run SaifCTL again.

#### Other setups

Any Docker backend that does not place the socket at `/var/run/docker.sock` needs the same idea: set **`DOCKER_HOST`** to the **`unix://...`** (or `tcp://...`) URL the engine documents.

### Buildx on macOS

**Symptom:** While building images (e.g. `pnpm docker build coder`), Docker prints that the **legacy builder is deprecated** and suggests installing **buildx**, or **`docker buildx`** is not found after installing the CLI plugin via Homebrew.

**Fix:**

1. Install the plugin:

   ```bash
   brew install docker-buildx
   ```

2. **`docker-buildx` is a Docker plugin.** For Docker to find it, add **`cliPluginsExtraDirs`** to **`~/.docker/config.json`** (merge with any existing keys; do not remove other settings):

   ```json
   {
     "cliPluginsExtraDirs": [
       "/opt/homebrew/lib/docker/cli-plugins"
     ]
   }
   ```

   On **Intel Macs**, Homebrew often uses `/usr/local` instead of `/opt/homebrew`; if the path above does not exist, use:

   ```text
   /usr/local/lib/docker/cli-plugins
   ```

3. Confirm: `docker buildx version`

You can also enable BuildKit for plain **`docker build`** (avoids the legacy builder in many setups): `export DOCKER_BUILDKIT=1` (see [Docker BuildKit](https://docs.docker.com/build/buildkit/)).

---

See also:

- [Environment variables](env-vars.md) — **`DOCKER_HOST`** and **`SAIFCTL_LEASH_BIN`**
- [Docker images & host notes](development/docker.md) — short summary of dockerode vs CLI

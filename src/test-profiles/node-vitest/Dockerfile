FROM node:25-alpine

# Pre-install the exact tools needed by the test runner container.
# This image is intentionally fixed — it never changes between runs,
# so Docker layer caching makes every subsequent pull a no-op.
RUN npm install -g vitest tsx --no-progress

WORKDIR /workspace

# Entrypoint script — reads env vars provided by the Orchestrator and runs the test suite.
# See src/test-profiles/node-vitest/test.sh for the full contract (env vars, exit codes, output file format).
#
# NOTE: test.sh is NOT baked into this image. The Orchestrator always bind-mounts it at
#    /usr/local/bin/test.sh:ro from src/test-profiles/node-vitest/test.sh (or a custom
#    override supplied via --test-script). This allows changing the test runner without
#    rebuilding the image.
CMD ["/bin/sh", "/usr/local/bin/test.sh"]

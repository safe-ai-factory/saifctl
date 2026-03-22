#!/usr/bin/env bash
# Build the library and produce an npm tarball under dist-pack/ (for CI and local verification).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pnpm run build

OUT="${ROOT}/dist-pack"
rm -rf "${OUT}"
mkdir -p "${OUT}"

npm pack --pack-destination "${OUT}"

echo "Tarball written to ${OUT}/"
ls -la "${OUT}"

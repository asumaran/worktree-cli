#!/usr/bin/env bash
#
# update-local.sh — update this machine's global `wt` install to the latest
# published GitHub release.
#
# This is intentionally separate from scripts/release.sh: cutting a release and
# updating your own install are different actions. A global install made with
# `pnpm add -g <url>` pins the *resolved* versioned tarball URL, so it never
# follows later releases on its own — run this whenever you want to move to the
# latest published version.
#
# Usage:
#   scripts/update-local.sh
#
set -euo pipefail

REPO="asumaran/worktree-cli"

command -v gh >/dev/null 2>&1   || { echo "error: GitHub CLI (gh) is required." >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is required." >&2; exit 1; }

echo "==> Resolving the latest release tarball for ${REPO}..."
url="$(gh release view -R "$REPO" --json assets \
  -q '.assets[] | select(.name | endswith(".tgz")) | .url')"
if [ -z "$url" ]; then
  echo "error: the latest release has no .tgz asset yet (CI may still be building)." >&2
  exit 1
fi

echo "==> Installing: pnpm add -g ${url}"
pnpm add -g "$url"

echo "updated. wt is now: $(wt --version 2>/dev/null || echo 'unknown')"

#!/usr/bin/env bash
#
# release.sh — cut a new wt release, gated on a clean tree and a green build+test.
#
# Releases are created from a tag: a GitHub Actions workflow then builds the
# project, packs a tarball whose version matches the tag, and attaches it. This
# script makes sure we never tag a half-finished or broken state:
#
#   1. the working tree must be clean (the tag == exactly what is committed)
#   2. `pnpm test` must pass (it builds first via the `pretest` hook)
#   3. CHANGELOG.md must already document the target version
#
# Only then does it bump package.json, commit, tag `vX.Y.Z`, and push.
#
# Usage:
#   scripts/release.sh 1.1.2          # release version 1.1.2
#   scripts/release.sh 1.1.2 --no-push  # do everything locally, skip push
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DO_PUSH=true
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --no-push) DO_PUSH=false ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "unknown argument: $arg" >&2; exit 2 ;;
    *)         VERSION="$arg" ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "error: version required, e.g. scripts/release.sh 1.1.2" >&2
  exit 2
fi
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: '$VERSION' is not a valid X.Y.Z version" >&2
  exit 2
fi

tag="v${VERSION}"

# --- preconditions ----------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty; commit or stash before releasing." >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  echo "error: tag ${tag} already exists." >&2
  exit 1
fi
if ! grep -qE "^## (v?\[?${VERSION//./\\.})" CHANGELOG.md; then
  echo "error: CHANGELOG.md has no entry for ${VERSION}; add it before releasing." >&2
  exit 1
fi

# --- quality gate -----------------------------------------------------------
# `pnpm test` builds first via the `pretest` hook, so the build is covered here.
echo "==> Building and testing..."
pnpm test

# --- apply ------------------------------------------------------------------
echo "==> Bumping package.json to ${VERSION}..."
tmp="$(mktemp)"
jq --arg v "$VERSION" '.version = $v' package.json > "$tmp"
mv "$tmp" package.json

git add package.json
git commit -m "chore(release): ${tag}"
git tag "$tag"

if $DO_PUSH; then
  git push origin HEAD
  git push origin "$tag"
  # The build workflow triggers on a *published GitHub release*, not on a tag
  # push, so create the release (which also generates notes). This is what
  # attaches the installable tarball.
  gh release create "$tag" --verify-tag --generate-notes --title "$tag"
  echo "released ${tag}: pushed branch + tag and published the GitHub release. CI will attach the tarball."
else
  echo "released ${tag} locally (tag created, not pushed)."
  echo "Finish with: git push origin HEAD && git push origin ${tag} && gh release create ${tag} --verify-tag --generate-notes --title ${tag}"
fi

#!/usr/bin/env bash
# Cut a release: bump the version, run the tests, then push the commit and the
# tag. The tag push is what starts .github/workflows/publish.yml, so nothing is
# published from this machine.
#
#   scripts/release.sh patch    # 2.2.0 -> 2.2.1
#   scripts/release.sh minor    # 2.2.0 -> 2.3.0
#   scripts/release.sh major    # 2.2.0 -> 3.0.0
set -euo pipefail

bump="${1:-patch}"
case "$bump" in
  patch | minor | major) ;;
  *)
    echo "usage: scripts/release.sh [patch|minor|major]" >&2
    exit 1
    ;;
esac

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "releases are cut from main, not '$branch'" >&2
  exit 1
fi

# The workflow publishes only the tagged commit, so the local clone must be the
# same commit the remote has.
git fetch --tags --quiet origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "main is not in sync with origin/main; pull or push first" >&2
  exit 1
fi

# Catch a broken harness here, not in CI after the tag is already pushed.
npm test

# npm version bumps package.json, commits, and creates the v<version> tag that
# the workflow matches on. It refuses to run on a dirty tree, which is why the
# checks above come first.
npm version "$bump" -m "chore(release): v%s"

version="$(node -p "require('./package.json').version")"
tag="v${version}"

git push origin main
git push origin "$tag"

echo
echo "pushed $tag; the publish workflow is now running:"
echo "  gh run watch"
echo "  gh release view $tag"

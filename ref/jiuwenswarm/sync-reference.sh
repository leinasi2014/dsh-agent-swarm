#!/usr/bin/env sh
set -eu

repository='https://github.com/openJiuwen-ai/jiuwenswarm.git'
commit='1d45d2b4a08423365eae7c37b2afdae6614a97ad'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target="$script_dir/source"

command -v git >/dev/null 2>&1 || {
  echo 'git is required' >&2
  exit 1
}

if [ ! -d "$target/.git" ]; then
  if [ -d "$target" ] && [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "reference target exists but is not a Git checkout: $target" >&2
    exit 1
  fi
  mkdir -p "$target"
  git -C "$target" init
  git -C "$target" remote add origin "$repository"
else
  if [ -n "$(git -C "$target" status --porcelain)" ]; then
    echo 'reference checkout has local changes; preserve or remove them before syncing' >&2
    exit 1
  fi
  git -C "$target" remote set-url origin "$repository"
fi

git -C "$target" lfs install --local --skip-smudge >/dev/null 2>&1 || true
git -C "$target" fetch --depth 1 origin "$commit"
git -C "$target" checkout --detach FETCH_HEAD

actual=$(git -C "$target" rev-parse HEAD)
[ "$actual" = "$commit" ] || {
  echo "reference checkout mismatch: expected $commit, got $actual" >&2
  exit 1
}

echo "Reference source ready: $target @ $actual (Git LFS media skipped)"

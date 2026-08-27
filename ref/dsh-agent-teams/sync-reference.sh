#!/usr/bin/env sh
set -eu

repository='https://github.com/NanmiCoder/dsh-agent-teams.git'
commit='5fe388f1a30da7b1374294b25bd6f8ad74ab6aa5'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target="$script_dir/source"

command -v git >/dev/null 2>&1 || { echo 'git is required' >&2; exit 1; }

if [ ! -d "$target/.git" ]; then
  rm -rf "$target"
  mkdir -p "$target"
  git -C "$target" init
  git -C "$target" remote add origin "$repository"
else
  git -C "$target" remote set-url origin "$repository"
fi

git -C "$target" fetch --depth 1 origin "$commit"
git -C "$target" checkout --detach FETCH_HEAD
actual=$(git -C "$target" rev-parse HEAD)
[ "$actual" = "$commit" ] || { echo "reference checkout mismatch: $actual" >&2; exit 1; }
printf 'Reference source ready: %s @ %s\n' "$target" "$actual"

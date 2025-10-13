#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bk="$ROOT/ShadowMap/shadow-map-backend"
legacy="$bk/scripts/legacy"

mkdir -p "$legacy"

move_if_exists() {
  local src="$1" dst="$2"
  if [[ -e "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    git mv -f "$src" "$dst" 2>/dev/null || mv -f "$src" "$dst"
    echo "moved: $src -> $dst"
  fi
}

# Shell scripts for offline/local data workflows
for pattern in \
  "$bk"/download-*.sh \
  "$bk"/test-*.sh \
  "$bk"/verify-*.sh \
  "$bk"/explore-*.sh
do
  for f in $pattern; do
    [[ -e "$f" ]] && move_if_exists "$f" "$legacy/$(basename "$f")"
  done
done

# Node helpers mainly for preloading/caching local data
for f in \
  preload-data.js \
  preload-dem.js \
  tum-cache-manager.js
do
  move_if_exists "$bk/$f" "$legacy/$f"
done

echo "✅ Archived legacy local-data helpers to $legacy"


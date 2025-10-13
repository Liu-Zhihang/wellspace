#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

proto_dir="$ROOT/ShadowMap/prototypes"
react_dir="$proto_dir/react"
tools_dir="$proto_dir/tools"

mkdir -p "$proto_dir" "$react_dir" "$tools_dir"

move_if_exists() {
  local src="$1" dst="$2"
  if [[ -e "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    git mv -f "$src" "$dst" 2>/dev/null || mv -f "$src" "$dst"
    echo "moved: $src -> $dst"
  fi
}

# Frontend root prototypes
for f in \
  beijing-dem-test.html \
  building-api-test.html \
  building-api-test-simple.html \
  building-api-test-improved.html \
  index.html \
  js-debug-test.html \
  shadow-calculator-test.html \
  shadow-simulator-integrated-fixed.html \
  shadow-simulator.html \
  connection-test.html
do
  move_if_exists "$ROOT/ShadowMap/shadow-map-frontend/$f" "$proto_dir/$f"
done

# React test pages/assets
for f in \
  test-backend.html \
  test-clean-component.html \
  test-mapbox-sync.js
do
  move_if_exists "$ROOT/ShadowMap/shadow-map-frontend/react-shadow-app/$f" "$react_dir/$f"
done

# Dev-only util out of src
move_if_exists \
  "$ROOT/ShadowMap/shadow-map-frontend/react-shadow-app/src/utils/testBuildingData.js" \
  "$tools_dir/testBuildingData.js"

echo "✅ Prototype organization complete. Review changes and run builds."


#!/usr/bin/env bash
# Installs a pinned Gitleaks release and refuses it unless its checksum matches.
set -euo pipefail
version="8.30.1"
sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
dir="${RUNNER_TEMP:-/tmp}/gitleaks-$version"
mkdir -p "$dir"
archive="$dir/gitleaks.tar.gz"
curl --fail --silent --show-error --location --retry 3 --output "$archive" \
  "https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_linux_x64.tar.gz"
echo "$sha256  $archive" | sha256sum --check --quiet
tar -xzf "$archive" -C "$dir" gitleaks
echo "GITLEAKS_BIN=$dir/gitleaks" >> "$GITHUB_ENV"

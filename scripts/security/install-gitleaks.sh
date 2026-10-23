#!/usr/bin/env bash
set -euo pipefail
# Reviewed upstream release artifact; no mutable installer/action code is run.
destination="${1:?Provide an installation directory}"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) ;;
  *) echo 'This pinned scanner bootstrap supports Linux x86_64.' >&2; exit 1 ;;
esac
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz' \
  --output "$scratch/gitleaks.tar.gz"
echo '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  gitleaks.tar.gz' > "$scratch/checksums"
(cd "$scratch" && sha256sum --check checksums)
mkdir -p "$destination"
tar -xzf "$scratch/gitleaks.tar.gz" -C "$destination" gitleaks

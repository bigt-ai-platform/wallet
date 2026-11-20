#!/usr/bin/env bash
# Point git at the versioned hooks in scripts/git-hooks.
#
#   ./scripts/install-git-hooks.sh
#
# The hooks are committed, so every checkout gets the same guard once this runs.
# It sets core.hooksPath rather than copying files, so updates apply without
# re-running it. Undo with: git config --unset core.hooksPath
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

chmod +x scripts/git-hooks/*

git config core.hooksPath scripts/git-hooks
echo "core.hooksPath -> scripts/git-hooks"
echo "active hooks: $(ls scripts/git-hooks | tr '\n' ' ')"

#!/usr/bin/env bash
# docs-upload.sh — DEPRECATED alias for scripts/publishpdf.sh (kept so existing
# scripts/notes keep working). Use `scripts/publishpdf.sh` (or `yarn publishpdf`)
# directly: it publishes the rendered guide PDFs to
# apps/wallet/docs/demo on s3.bigt.ai and verifies every read site.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/publishpdf.sh" "$@"

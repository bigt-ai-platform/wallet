#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="bapp-android-builder"

if ! command -v docker &>/dev/null; then
  echo "Error: docker not found. Install Docker first."
  exit 1
fi

echo "==> Building Docker image (first time only)..."
docker build -t "$IMAGE" -f "$ROOT/Dockerfile.android" "$ROOT" 2>&1 | tail -3

echo "==> Installing dependencies..."
cd "$ROOT"
yarn install --frozen-lockfile 2>&1 | tail -3
cd "$ROOT/expo-app"

echo "==> Running Android prebuild + detox build inside container..."
docker run --rm \
    -v "$ROOT:/workspace" \
    -v /tmp:/tmp \
    -e HOME=/tmp \
    -w /workspace/expo-app \
    "$IMAGE" \
    bash -c "npx expo prebuild --platform android --no-install && yarn e2e:build:android" 2>&1

echo ""
echo "==> Done. APK: expo-app/android/app/build/outputs/apk/debug/app-debug.apk"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="bapp-android-builder"

echo "==> Building Docker image..."
docker build -t "$IMAGE" -f "$ROOT/Dockerfile.android" "$ROOT"

echo "==> Running Android build inside container..."
docker run --rm -ti \
    -v "$ROOT:/workspace" \
    -w /workspace/expo-app \
    "$IMAGE" \
    bash -c "
        yarn install --frozen-lockfile && \
        rm -rf android ios && \
        npx expo prebuild --platform android --no-install && \
        yarn e2e:build:android
    "

echo "==> Build complete. APK available at expo-app/android/app/build/outputs/apk/debug/"

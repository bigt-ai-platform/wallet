#!/bin/bash
# deploy.apk.sh — build the wallet Android APK (docker) and upload it to MinIO.
#
#   ./deploy.apk.sh                          # preview debug APK
#   ./deploy.apk.sh --release                # signed release APK
#   ./deploy.apk.sh --env production --release
#   ./deploy.apk.sh --skip-build             # upload the APK already in out/
#   ./deploy.apk.sh --no-latest              # skip the -latest aliases/manifest
#   ./deploy.apk.sh --no-prune               # keep older versioned artifacts in the prefix
#   ./deploy.apk.sh --fdroid                 # release APK + publish the self-hosted F-Droid repo
#
# Env:
#   APP_ENV          android variant (default preview)
#   BUILD_TYPE       debug|release (default debug)
#   ABI_SPLIT        e.g. arm64-v8a (default all four ABIs)
#   S3_ENDPOINT (default https://minio-s1001.bigt.ai)
#   S3_ACCESS_KEY / S3_SECRET_KEY (required)
#   S3_BUCKET (default apps) / S3_PREFIX (default wallet/apk)
#   OUT_DIR          local APK dir (default ./out)
#   IMAGE            builder image name (default wallet-android)
#   APP_VERSION      override the release version (default: latest git tag, else package.json)
#   MANDATORY        true to mark the release mandatory in the OTA manifest (default false)
#   PUBLIC_BASE_URL  public base the OTA manifest url is built from
#                    (default $S3_ENDPOINT/$S3_BUCKET)
#   FDROID_DIR       local F-Droid workspace (default $OUT_DIR/fdroid)
#   FDROID_S3_PREFIX bucket prefix for the repo (default wallet/fdroid)
#
# Uploads out/wallet-<env>-<type>-<app-version>.apk plus a
# wallet-<env>-<type>-latest.apk alias to s3://$S3_BUCKET/$S3_PREFIX/.
# For release APKs it also writes wallet-<env>-release-latest.json (the OTA
# manifest the app reads; see expo-app/sources/lib/ota.ts). The prefix then
# holds that one generation: older wallet-<env>-<type>-<version> objects of the
# same channel are removed once the upload verifies (--no-prune keeps them).
# Nothing public reads them — the app follows the manifest — and rebuilding
# from their git tag reproduces them.
set -euo pipefail

# A release must never stop for a keypress: every child (docker, node, gradle)
# gets EOF on stdin instead of the operator's terminal.
exec </dev/null

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

APP_ENV="${APP_ENV:-preview}"
BUILD_TYPE="${BUILD_TYPE:-debug}"
S3_ENDPOINT="${S3_ENDPOINT:-https://minio-s1001.bigt.ai}"
S3_BUCKET="${S3_BUCKET:-apps}"
S3_PREFIX="${S3_PREFIX:-wallet/apk}"
# Legacy OTA base baked into installs built before the move to the shared `apps`
# bucket (they fetch wallet-<env>-release-latest.json from here). Retired: the
# bucket it pointed at no longer exists, so the mirror is off by default — set
# LEGACY_OTA_BASE explicitly (e.g. to a redirect-backed prefix) to re-enable it.
LEGACY_OTA_BASE="${LEGACY_OTA_BASE-}"
OUT_DIR="${OUT_DIR:-$ROOT/out}"
IMAGE="${IMAGE:-wallet-android}"
SKIP_BUILD=0; LATEST=1; FDROID=0; PRUNE=1

for a in "$@"; do
  case "$a" in
    --release) BUILD_TYPE=release ;;
    --env=*) APP_ENV="${a#--env=}" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-latest) LATEST=0 ;;
    --no-prune) PRUNE=0 ;;
    --fdroid) FDROID=1 ;;
    --help|-h) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

: "${S3_ACCESS_KEY:?set S3_ACCESS_KEY}"
: "${S3_SECRET_KEY:?set S3_SECRET_KEY}"

# MinIO client image (overridable for a registry mirror). quay.io/minio/mc
# anonymous pulls are 401 — and a pull against a terminal never returns — so the
# default is the ghcr mirror of `mc`.
MC_IMAGE="${MC_IMAGE:-ghcr.io/bigt-ai-platform/mc:latest}"
# A registry pull must never stall a release: bound it, and fall back to the
# minio server image (which bundles `mc`) when the configured image is absent.
mc_pull() {
  # --kill-after, not just timeout: a `docker pull` that never returns ignores
  # SIGTERM, and GNU timeout then waits for it forever.
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=10 "${MC_PULL_TIMEOUT:-120}" docker pull "$1" >/dev/null 2>&1 || true
  else
    docker pull "$1" >/dev/null 2>&1 || true
  fi
}
if ! docker image inspect "$MC_IMAGE" >/dev/null 2>&1; then
  mc_pull "$MC_IMAGE"
fi
if ! docker image inspect "$MC_IMAGE" >/dev/null 2>&1; then
  alt="quay.io/minio/minio:latest"
  docker image inspect "$alt" >/dev/null 2>&1 || mc_pull "$alt"
  if docker image inspect "$alt" >/dev/null 2>&1; then
    echo "mc image $MC_IMAGE unavailable — using $alt (bundles mc)" >&2
    MC_IMAGE="$alt"
  fi
fi

# Release version: the highest semver tag (vX.Y.Z), else the app package
# version. versionCode is a monotonic integer (semver → major*1e6+minor*1e3+
# patch) so the on-device updater can compare against the manifest regardless
# of semver string formatting. Resolved via version.mjs (highest tag), NOT
# `git describe` — describe follows ancestry and goes backwards when a release
# tag lands on a rebased/cherry-picked commit, which makes every later build
# unpublishable and un-installable over the live release.
VERSION_MJS="$ROOT/webapp/scripts/version.mjs"
VERSION="${APP_VERSION:-$(node "$VERSION_MJS" name)}"
VERSION_CODE="${APP_VERSION_CODE:-$(node "$VERSION_MJS" code "$VERSION")}"
[ "${VERSION_CODE:-0}" -gt 0 ] || VERSION_CODE="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
# An explicit APP_VERSION must be a real tag: an untagged override is how the
# version drifts above the tag line, after which tag-derived builds are refused
# by the deploy's strictly-increasing check and the two silently diverge.
if [ -n "${APP_VERSION:-}" ] && ! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "refusing: APP_VERSION=$VERSION has no matching tag v$VERSION" >&2
  echo "    tag it first:  git tag -a v$VERSION -m \"wallet $VERSION\" && git push origin v$VERSION" >&2
  exit 1
fi
export APP_VERSION_NAME="$VERSION" APP_VERSION_CODE="$VERSION_CODE"
# Bake the release channel this APK updates from.
export EXPO_PUBLIC_APK_ENV="$APP_ENV"
# Public base used to build the OTA manifest's APK url.
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${S3_ENDPOINT%/}/$S3_BUCKET}"

ABI_SUFFIX=""
if [ -n "${ABI_SPLIT:-}" ]; then
  ABI_SUFFIX="-$(echo "$ABI_SPLIT" | tr ',' '+' | tr -d ' ')"
fi
NAME="wallet-$APP_ENV-$BUILD_TYPE-$VERSION.apk"
LATEST_NAME="wallet-$APP_ENV-$BUILD_TYPE-latest.apk"
FAMILY="wallet-$APP_ENV-$BUILD_TYPE"

if [ "$SKIP_BUILD" -eq 0 ]; then
  # Build the signed Capacitor artifact (static web export → cap sync → gradle
  # + signing) via webapp.sh. Needs webapp/keystore.properties, pinned in
  # webapp/signing.sha256 — every build carries the production certificate.
  # APP_VERSION_NAME/CODE + EXPO_PUBLIC_APK_ENV are exported above.
  case "$BUILD_TYPE" in
    release) ./webapp.sh --env="$APP_ENV" --release --no-install ;;
    *)       ./webapp.sh --env="$APP_ENV" --no-install ;;
  esac
fi
SRC="$ROOT/webapp/android/app/build/outputs/apk/$BUILD_TYPE/app-$BUILD_TYPE.apk"
APK="$OUT_DIR/wallet-$APP_ENV-$BUILD_TYPE.apk"
[ -f "$SRC" ] || { echo "missing built artifact $SRC (run without --skip-build first)" >&2; exit 1; }
# Last gate before an OTA manifest points devices at this file: a non-production
# signing key makes every upgrade of the installed app fail as incompatible.
node "$ROOT/webapp/scripts/signing.mjs" artifact "$SRC" \
  || { echo "signing check failed — $SRC is not signed with the production key" >&2; exit 1; }
node "$ROOT/webapp/scripts/appid.mjs" artifact "$SRC" \
  || { echo "package check failed — $SRC declares the wrong Android package" >&2; exit 1; }
cp -f "$SRC" "$APK"
sha256sum "$APK"

MC_ENV=(-e S3_ENDPOINT="$S3_ENDPOINT" -e S3_ACCESS_KEY="$S3_ACCESS_KEY" -e S3_SECRET_KEY="$S3_SECRET_KEY"
  -e S3_BUCKET="$S3_BUCKET" -e S3_PREFIX="$S3_PREFIX")

# mc cp inside the client container ($1 = source, $2 = destination). OUT_DIR is
# mounted read-write so the same helper can pull objects back for checking.
mc_cp() {
  docker run --rm "${MC_ENV[@]}" -v "$OUT_DIR:/out" -e MC_SRC="$1" -e MC_DST="$2" \
    --entrypoint /bin/sh "$MC_IMAGE" -c \
    'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && \
     mc cp "$MC_SRC" "$MC_DST"'
}

# Copy to an arbitrary host (the legacy OTA base during the migration), same
# creds. $1 = host url, $2 = source, $3 = destination (under the `h` alias).
mc_cp_host() {
  docker run --rm -e EP="$1" -e S3_ACCESS_KEY="$S3_ACCESS_KEY" -e S3_SECRET_KEY="$S3_SECRET_KEY" \
    -v "$OUT_DIR:/out" -e MC_SRC="$2" -e MC_DST="$3" \
    --entrypoint /bin/sh "$MC_IMAGE" -c \
    'mc alias set h "$EP" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && mc cp "$MC_SRC" "$MC_DST"'
}

# The release prefix is a distribution point, not an archive: it keeps only the
# generation just uploaded — the artifact, the -latest alias and the OTA
# manifest — and drops older versioned objects of the same channel, so a public
# prefix does not grow one ~7 MB object per release forever (the bucket had
# accumulated 1.0.64/1.0.65/1.0.84/1.0.85). Scoped to "$FAMILY"-*.apk/json, so
# the other channels (preview/debug) and the F-Droid repo (its own prefix,
# whose index intentionally lists every version it ever shipped) are never
# touched. Called only after the upload verified, so a failed publish never
# takes the previous release with it; --no-prune keeps the old objects.
#
# `apps` has versioning on (replication requires it) and no ILM rule, so a plain
# `mc rm` only writes a delete marker: the bytes stay, and every superseded
# -latest.apk/-latest.json also keeps its own non-current copies (~7 MB each).
# The kept objects are therefore trimmed to their newest version, and the stale
# keys are purged version-by-version. Deletes replicate to the peers (the rules
# carry DeleteReplication/DeleteMarkerReplication), so the space is reclaimed on
# every site, not just here.
prune_old_releases() {
  local listing line name vid ord
  local -a rows=() stale_keys=() del_keys=() pairs=()
  local -A newest=()

  if ! listing="$(docker run --rm "${MC_ENV[@]}" --entrypoint /bin/sh "$MC_IMAGE" -c \
      'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && mc ls --versions --recursive --json "up/$S3_BUCKET/$S3_PREFIX"')"; then
    echo "prune: could not list $S3_PREFIX — older artifacts left in place" >&2
    return 0
  fi

  # mc sorts newest first, but compare ordinals explicitly: the current version
  # of a kept key is the highest, whatever the listing order.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="$(printf '%s\n' "$line" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
    case "$name" in
      "$FAMILY"-*.apk|"$FAMILY"-*.json) ;;
      *) continue ;;
    esac
    vid="$(printf '%s\n' "$line" | sed -n 's/.*"versionId":"\([^"]*\)".*/\1/p')"
    ord="$(printf '%s\n' "$line" | sed -n 's/.*"versionOrdinal":\([0-9]*\).*/\1/p')"
    ord="${ord:-0}"
    rows+=("$name"$'\t'"$vid"$'\t'"$ord")
    case "$name" in
      "$NAME"|"$LATEST_NAME"|"$FAMILY-latest.json")
        if [ -z "${newest[$name]:-}" ] || [ "$ord" -gt "${newest[$name]}" ]; then
          newest[$name]="$ord"
        fi ;;
      *) stale_keys+=("$name") ;;
    esac
  done < <(printf '%s\n' "$listing")

  local row
  for row in "${rows[@]}"; do
    IFS=$'\t' read -r name vid ord <<<"$row"
    if [ -n "${newest[$name]:-}" ]; then
      # A kept key: drop everything but the version just published/verified.
      if [ "$ord" -lt "${newest[$name]}" ] && [ -n "$vid" ]; then
        pairs+=("$vid" "$name")
      fi
    fi
  done
  if [ "${#stale_keys[@]}" -gt 0 ]; then
    mapfile -t stale_keys < <(printf '%s\n' "${stale_keys[@]}" | sort -u)
    del_keys=("${stale_keys[@]}")
  fi

  if [ "${#del_keys[@]}" -eq 0 ] && [ "${#pairs[@]}" -eq 0 ]; then
    echo "prune: $S3_PREFIX holds only $VERSION + latest"
    return 0
  fi
  echo "prune: $S3_PREFIX keeps $NAME + $LATEST_NAME + $FAMILY-latest.json"
  if [ "${#del_keys[@]}" -gt 0 ]; then
    printf '    - %s (all versions)\n' "${del_keys[@]##*/}"
    docker run --rm "${MC_ENV[@]}" --entrypoint /bin/sh "$MC_IMAGE" -c \
      'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null || exit 1
       for k in "$@"; do mc rm --versions --force "up/$S3_BUCKET/$S3_PREFIX/$k" || exit 1; done' \
      sh "${del_keys[@]}" || echo "warning: prune of stale artifacts failed — left in $S3_PREFIX" >&2
  fi
  if [ "${#pairs[@]}" -gt 0 ]; then
    echo "    - $(( ${#pairs[@]} / 2 )) superseded version(s) of the kept objects"
    docker run --rm "${MC_ENV[@]}" --entrypoint /bin/sh "$MC_IMAGE" -c \
      'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null || exit 1
       while [ "$#" -gt 1 ]; do
         mc rm --version-id "$1" "up/$S3_BUCKET/$S3_PREFIX/$2" >/dev/null || exit 1
         shift 2
       done' sh "${pairs[@]}" || echo "warning: prune of superseded versions failed — left in $S3_PREFIX" >&2
  fi
}

# Key check: what is live right now. A release published under a different
# certificate leaves every installed copy unable to upgrade in place
# (INSTALL_FAILED_UPDATE_INCOMPATIBLE), so say so before overwriting the object
# those devices are pointed at. Warns rather than fails — publishing a fixed,
# production-signed release over a wrongly signed one is the repair.
LIVE_JSON=".live-$APP_ENV-$BUILD_TYPE.json"
LIVE_APK=".live-$APP_ENV-$BUILD_TYPE.apk"
if [ "$LATEST" -eq 1 ] && [ "$BUILD_TYPE" = "release" ] \
  && mc_cp "up/$S3_BUCKET/$S3_PREFIX/wallet-$APP_ENV-release-latest.json" "/out/$LIVE_JSON" 2>/dev/null; then
  LIVE_VER="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(String(j.versionName ?? "?")+" / code "+String(j.versionCode ?? "?"))' "$OUT_DIR/$LIVE_JSON" 2>/dev/null || echo unknown)"
  LIVE_URL="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(typeof j.url === "string" ? j.url : "")' "$OUT_DIR/$LIVE_JSON" 2>/dev/null || true)"
  LIVE_KEY="${LIVE_URL#*"$S3_PREFIX/"}"
  # versionCode must strictly increase. The OTA updater compares codes, and
  # Android refuses a same-or-older install, so publishing a regression would
  # hand every device an update it can never take (today the code comes from
  # `git describe`, which goes backwards after a tag moves).
  LIVE_CODE="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(Number(j.versionCode)||0)' "$OUT_DIR/$LIVE_JSON" 2>/dev/null || echo 0)"
  if [ "${LIVE_CODE:-0}" -ge "$VERSION_CODE" ]; then
    echo "refusing to publish: the live manifest is versionCode $LIVE_CODE but this build is $VERSION_CODE" >&2
    echo "    versionCode must strictly increase — pass APP_VERSION=<newer> (and tag it)." >&2
    rm -f "$OUT_DIR/$LIVE_JSON" "$OUT_DIR/$LIVE_APK"
    exit 1
  fi
  if [ -n "$LIVE_URL" ] && [ "$LIVE_KEY" != "$LIVE_URL" ] \
    && mc_cp "up/$S3_BUCKET/$S3_PREFIX/$LIVE_KEY" "/out/$LIVE_APK" 2>/dev/null; then
    if LIVE_SIGNING="$(node "$ROOT/webapp/scripts/signing.mjs" artifact "$OUT_DIR/$LIVE_APK" 2>&1)"; then
      echo "live: published release ($LIVE_VER) carries the production key"
    elif printf '%s' "$LIVE_SIGNING" | grep -q "not the production key"; then
      echo "WARNING: the published release ($LIVE_VER) is signed by a DIFFERENT certificate:" >&2
      printf '%s\n' "$LIVE_SIGNING" | sed 's/^/    /' >&2
      echo "    devices running it cannot upgrade in place and must be reinstalled;" >&2
      echo "    publishing a production-signed release does not repair them." >&2
    else
      echo "note: could not check the published release: $LIVE_SIGNING" >&2
    fi
  fi
elif [ "$LATEST" -eq 1 ] && [ "$BUILD_TYPE" = "release" ]; then
  echo "live: no published $APP_ENV-release manifest to compare against"
fi
rm -f "$OUT_DIR/$LIVE_JSON" "$OUT_DIR/$LIVE_APK"

mc_cp "/out/$(basename "$APK")" "up/$S3_BUCKET/$S3_PREFIX/$NAME" \
  || { echo "upload failed — check S3_* creds" >&2; exit 1; }
if [ "$LATEST" -eq 1 ]; then
  mc_cp "up/$S3_BUCKET/$S3_PREFIX/$NAME" "up/$S3_BUCKET/$S3_PREFIX/$LATEST_NAME" \
    || { echo "latest-alias copy failed" >&2; exit 1; }
fi

# OTA version manifest — the on-device updater fetches this straight from the
# (public-read) release prefix and compares versionCode. Every build carries the
# production certificate now, but only the release variant publishes a manifest.
if [ "$LATEST" -eq 1 ] && [ "$BUILD_TYPE" = "release" ]; then
  SHA="$(sha256sum "$APK" | awk '{print $1}')"
  MANIFEST="wallet-$APP_ENV-release-latest.json"
  printf '{"versionName":"%s","versionCode":%s,"url":"%s/%s/%s","sha256":"%s","mandatory":%s}\n' \
    "$VERSION" "$VERSION_CODE" "${PUBLIC_BASE_URL%/}" "$S3_PREFIX" "$NAME" "$SHA" "${MANDATORY:-false}" \
    > "$OUT_DIR/$MANIFEST"
  mc_cp "/out/$MANIFEST" "up/$S3_BUCKET/$S3_PREFIX/$MANIFEST" \
    || { echo "manifest upload failed" >&2; exit 1; }
  echo "uploaded: $PUBLIC_BASE_URL/$S3_PREFIX/$MANIFEST ($VERSION / code $VERSION_CODE)"
  # Migration cutover (opt-in): installs built before the move to `apps` have a
  # legacy base baked, but the manifest's `url` already points at the new apps/…
  # object, so mirroring only the manifest keeps them upgrading. Non-fatal, and
  # skipped unless LEGACY_OTA_BASE is set explicitly (the old base is retired).
  if [ -n "$LEGACY_OTA_BASE" ]; then
    LEGACY_REST="${LEGACY_OTA_BASE#*://}"
    LEGACY_HOST="https://${LEGACY_REST%%/*}"        # scheme://host (mc alias rejects a path)
    LEGACY_KEY="${LEGACY_REST#*/}"                  # bucket/prefix
    mc_cp_host "$LEGACY_HOST" "/out/$MANIFEST" "h/$LEGACY_KEY/$MANIFEST" \
      || echo "warning: could not mirror $MANIFEST to the legacy base $LEGACY_OTA_BASE" >&2
  fi
fi

# Verify what we actually published: the OTA manifest points devices at this
# exact object, so re-download it and confirm both the bytes and the key.
VERIFY_APK=".verify-$APP_ENV-$BUILD_TYPE.apk"
mc_cp "up/$S3_BUCKET/$S3_PREFIX/$NAME" "/out/$VERIFY_APK" \
  || { echo "could not re-download $S3_PREFIX/$NAME to verify it" >&2; exit 1; }
WANT_SHA="$(sha256sum "$APK" | awk '{print $1}')"
GOT_SHA="$(sha256sum "$OUT_DIR/$VERIFY_APK" | awk '{print $1}')"
[ "$WANT_SHA" = "$GOT_SHA" ] || {
  echo "uploaded object sha256 $GOT_SHA != built $WANT_SHA" >&2; exit 1; }
node "$ROOT/webapp/scripts/signing.mjs" artifact "$OUT_DIR/$VERIFY_APK" \
  || { echo "uploaded object is not signed with the production key" >&2; exit 1; }
node "$ROOT/webapp/scripts/appid.mjs" artifact "$OUT_DIR/$VERIFY_APK" \
  || { echo "uploaded object declares the wrong Android package" >&2; exit 1; }
rm -f "$OUT_DIR/$VERIFY_APK"
echo "verified: $S3_PREFIX/$NAME ($GOT_SHA, production key)"

# Same-generation policy: keep only what was just verified (see the helper).
if [ "$PRUNE" -eq 1 ]; then
  prune_old_releases
fi

# --fdroid: also publish the release APK into a self-hosted F-Droid repo
# (workspace under $FDROID_DIR, listing text from ./fdroid/metadata/) and mirror
# it to $FDROID_S3_PREFIX/repo. The repo index is signed with the app's release
# key (webapp/keystore.properties).
publish_fdroid() {
  local apk="$1"
  local fd_dir="${FDROID_DIR:-$OUT_DIR/fdroid}"
  local s3_prefix="${FDROID_S3_PREFIX:-wallet/fdroid}"
  local venv="${FDROID_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/fdroidserver-venv}"
  local props="$ROOT/webapp/keystore.properties"
  local base="${PUBLIC_BASE_URL:-${S3_ENDPOINT%/}/$S3_BUCKET}"
  local repo_url="${FDROID_REPO_URL:-${base%/}/$s3_prefix/repo}"

  # fdroidserver needs JDK tools (jar/keytool) and apksigner (via ANDROID_HOME).
  if ! command -v jar >/dev/null 2>&1; then
    local jdk=""
    if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/jar" ]; then jdk="$JAVA_HOME"
    else for d in "$HOME"/.local/java-* /usr/lib/jvm/*; do [ -x "$d/bin/jar" ] && jdk="$d"; done; fi
    [ -n "$jdk" ] && PATH="$jdk/bin:$PATH" || { echo "fdroid: a JDK is required (jar on PATH or JAVA_HOME)" >&2; exit 1; }
  fi
  local aapt
  aapt="$(ls "${ANDROID_HOME:-/nonexistent}"/build-tools/*/aapt 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$aapt" ] || { echo "fdroid: ANDROID_HOME is required (aapt/apksigner)" >&2; exit 1; }

  if [ ! -x "$venv/bin/fdroid" ]; then
    echo "fdroid: creating fdroidserver venv at $venv (one-time, needs network)"
    python3 -m venv "$venv"
    "$venv/bin/pip" install -q --disable-pip-version-check fdroidserver
  fi
  local FDBIN="$venv/bin/fdroid"

  # Sign the index with the release key, read from keystore.properties.
  local keystore keyalias kspass
  keystore="${FDROID_KEYSTORE:-$(sed -n 's/^storeFile=//p' "$props" 2>/dev/null | head -1)}"
  keyalias="${FDROID_KEY_ALIAS:-$(sed -n 's/^keyAlias=//p' "$props" 2>/dev/null | head -1)}"
  kspass="${FDROID_KEY_PASS:-$(sed -n 's/^storePassword=//p' "$props" 2>/dev/null | head -1)}"
  [ -f "$keystore" ] || { echo "fdroid: keystore not found: ${keystore:-<none>} — see $props or FDROID_KEYSTORE" >&2; exit 1; }
  [ -n "$keyalias" ] && [ -n "$kspass" ] || { echo "fdroid: keystore alias/password missing — see $props or FDROID_KEY_ALIAS/FDROID_KEY_PASS" >&2; exit 1; }
  local keydname
  keydname="$(keytool -list -v -keystore "$keystore" -storepass "$kspass" -alias "$keyalias" 2>/dev/null | sed -n 's/^Owner: //p' | head -1)"
  [ -n "$keydname" ] || { echo "fdroid: cannot read the certificate DN for '$keyalias' in $keystore" >&2; exit 1; }

  local app_id version_code
  app_id="$("$aapt" dump badging "$apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
  version_code="$("$aapt" dump badging "$apk" | sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p")"
  [ -n "$app_id" ] && [ -n "$version_code" ] || { echo "fdroid: cannot read package/version from $apk" >&2; exit 1; }

  [ -d "$ROOT/fdroid/metadata" ] || { echo "fdroid: $ROOT/fdroid/metadata is missing" >&2; exit 1; }
  mkdir -p "$fd_dir/repo" "$fd_dir/metadata"
  cp -f "$ROOT"/fdroid/metadata/*.yml "$fd_dir/metadata/"
  cat > "$fd_dir/config.yml" <<EOF
repo_url: $repo_url
repo_name: ${FDROID_REPO_NAME:-Wallet}
repo_description: ${FDROID_REPO_DESCRIPTION:-Wallet Android builds, published by bigt.ai}
keystore: $keystore
repo_keyalias: $keyalias
keystorepass: $kspass
keypass: $kspass
keydname: $keydname
EOF
  chmod 600 "$fd_dir/config.yml"
  cp -f "$apk" "$fd_dir/repo/${app_id}_${version_code}.apk"

  ( cd "$fd_dir" && "$FDBIN" update )

  docker run --rm \
    -e S3_ENDPOINT="$S3_ENDPOINT" -e S3_ACCESS_KEY="$S3_ACCESS_KEY" -e S3_SECRET_KEY="$S3_SECRET_KEY" \
    -e S3_BUCKET="$S3_BUCKET" -e S3_PREFIX="$s3_prefix" \
    -v "$fd_dir/repo:/fdroid-repo:ro" --entrypoint /bin/sh "$MC_IMAGE" -c \
    'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && \
     mc mirror --overwrite --remove /fdroid-repo "up/$S3_BUCKET/$S3_PREFIX/repo"' \
    || { echo "fdroid upload failed — check S3_* creds / MC_IMAGE ($MC_IMAGE)" >&2; exit 1; }

  local fp
  fp="$(keytool -list -v -keystore "$keystore" -storepass "$kspass" 2>/dev/null | sed -n 's/.*SHA256: //p' | head -1 || true)"
  echo "fdroid repo: $repo_url"
  echo "fdroid key : ${fp:-fingerprint unavailable}"
}

if [ "$FDROID" -eq 1 ]; then
  [ "$BUILD_TYPE" = release ] || { echo "--fdroid publishes release APKs only (not $BUILD_TYPE)" >&2; exit 1; }
  publish_fdroid "$APK"
fi

echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$NAME"
if [ "$LATEST" -eq 1 ]; then echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$LATEST_NAME"; fi

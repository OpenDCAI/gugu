#!/usr/bin/env bash
# Cross-platform Android gradle build for apps/mobile/android.
# Toolchain comes ONLY from the environment — no hardcoded fallbacks (no Mac
# /opt/homebrew defaults that silently fail on Linux). Missing env → fail loud.
#
# Usage: scripts/android-gradle-build.sh <gradle-task>
#   e.g. scripts/android-gradle-build.sh assembleDebug
#        scripts/android-gradle-build.sh assembleRelease   (loads signing env from .env.local)
#
# Toolchain (set before running; to avoid provisioning a local SDK entirely, run the
# `Android` workflow in CI instead -- Actions tab -> Run workflow):
#   JAVA_HOME          JDK 21
#   ANDROID_HOME       Android SDK root  (ANDROID_SDK_ROOT is derived from it if unset)
#   ANDROID_SDK_ROOT   Android SDK root  (ANDROID_HOME is derived from it if unset)
set -euo pipefail

TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "error: gradle task required, e.g. scripts/android-gradle-build.sh assembleDebug" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/apps/mobile/android"

# ANDROID_HOME / ANDROID_SDK_ROOT: accept either, derive the other.
if [ -z "${ANDROID_HOME:-}" ] && [ -n "${ANDROID_SDK_ROOT:-}" ]; then
  ANDROID_HOME="$ANDROID_SDK_ROOT"
fi
if [ -z "${ANDROID_SDK_ROOT:-}" ] && [ -n "${ANDROID_HOME:-}" ]; then
  ANDROID_SDK_ROOT="$ANDROID_HOME"
fi

missing=()
[ -n "${JAVA_HOME:-}" ] || missing+=("JAVA_HOME (JDK 21)")
[ -n "${ANDROID_HOME:-}" ] || missing+=("ANDROID_HOME or ANDROID_SDK_ROOT (Android SDK root)")
if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo "error: Android toolchain not configured. Missing:"
    for m in "${missing[@]}"; do echo "  - $m"; done
    echo
    echo "Set these to your local JDK 21 / Android SDK, e.g.:"
    echo "  export JAVA_HOME=/path/to/jdk-21"
    echo "  export ANDROID_HOME=/path/to/android-sdk"
    echo
    echo "Or skip the local toolchain entirely: run the 'Android' workflow in CI"
    echo "  (GitHub Actions tab -> Android -> Run workflow)."
  } >&2
  exit 1
fi

for var in JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT; do
  dir="${!var}"
  if [ ! -d "$dir" ]; then
    echo "error: $var points to a non-existent directory: $dir" >&2
    exit 1
  fi
done

export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT

# @@@one-file-per-env 一套环境 = 一个文件 .envs/<target>.env（签名与库凭据同住一份）。
# .env.local 已退役：存在即 fail loud，别让人以为填了就生效。
if [ -f "$ROOT_DIR/.env.local" ]; then
  echo "error: .env.local 已退役（一套环境一个文件）。搬迁：node scripts/build-env-preflight.mts --migrate <prod|shared-test|local>" >&2
  exit 1
fi

# Release builds need signing config; it lives in the named environment's file.
if [ "$TASK" = "assembleRelease" ]; then
  if [ -z "${GUGU_DB_TARGET:-}" ]; then
    echo "error: assembleRelease needs GUGU_DB_TARGET=<prod|shared-test|local> —— 签名配置住在 .envs/\$GUGU_DB_TARGET.env" >&2
    exit 1
  fi
  ENV_FILE="$ROOT_DIR/.envs/$GUGU_DB_TARGET.env"
  if [ ! -f "$ENV_FILE" ]; then
    echo "error: assembleRelease needs signing config from $ENV_FILE (not found)" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC2046
  export $(grep -E '^(ANDROID_KEYSTORE_PATH|ANDROID_KEYSTORE_PASSWORD|ANDROID_KEY_ALIAS|ANDROID_KEY_PASSWORD)=' "$ENV_FILE" | xargs)
  set +a
fi

cd "$ANDROID_DIR"
exec ./gradlew "$TASK"

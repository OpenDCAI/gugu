#!/usr/bin/env bash
set -euo pipefail

# Install native modules on the Ubuntu 24.04 host, which has the compiler toolchain absent
# from the Noble browser image. Keep their absolute paths and the exact Node/pnpm runtime.
node_root=$(dirname "$(dirname "$(command -v node)")")
pnpm_root=$(dirname "$(dirname "$(command -v pnpm)")")
docker run --rm --init --ipc=host --network=host \
  --volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE" \
  --volume "$RUNNER_TEMP:$RUNNER_TEMP" \
  --volume "$node_root:$node_root:ro" \
  --volume "$pnpm_root:$pnpm_root:ro" \
  --workdir "$GITHUB_WORKSPACE" \
  --env PATH --env CI \
  --env GUGU_SUPABASE_URL --env VITE_SUPABASE_URL \
  --env GUGU_SUPABASE_ANON_KEY --env VITE_SUPABASE_ANON_KEY \
  --env GUGU_DB_TARGET --env GUGU_E2E_CI_PROJECT --env GUGU_E2E_PORT --env GUGU_E2E_RUN_ID \
  --env NODE_OPTIONS --env GUGU_VITEST_JSON_REPORT \
  "$PLAYWRIGHT_IMAGE" bash --noprofile --norc -e -o pipefail -c '
    git config --global --add safe.directory "$PWD"
    node -e '\''
      const fs = require("node:fs");
      const assert = require("node:assert/strict");
      assert.equal(process.versions.node, fs.readFileSync(".node-version", "utf8").trim());
      const image = JSON.parse(fs.readFileSync("/ms-playwright/.docker-info", "utf8"));
      assert.equal(image.driverVersion, require("playwright/package.json").version);
      require("node-pty");
      new (require("better-sqlite3"))(":memory:").close();
      require("@parcel/watcher");
      console.log(`Playwright ${image.driverVersion}; Node ${process.versions.node}; native modules loaded`);
    '\''
    exec bash --noprofile --norc -e -o pipefail "$1"
  ' -- "$1"

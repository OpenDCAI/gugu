/** The run preloader is shipped verbatim and runs in the same PID before any application module. */
export function serverLauncher(version, channel) {
  const suffix = channel === 'stable' ? '' : `-${channel}`
  return `#!/bin/sh
set -e
self="$0"
while [ -L "$self" ]; do
  target="$(readlink "$self")"
  case "$target" in /*) self="$target" ;; *) self="$(dirname "$self")/$target" ;; esac
done
dir="$(cd "$(dirname "$self")/.." && pwd -P)"
export GUGU_TASK_HOST_APP_PATH="$dir/app"
export GUGU_TASK_HOST_VERSION="${version}"
case "$(uname -s)" in
  Linux) export MALLOC_MMAP_THRESHOLD_="\${MALLOC_MMAP_THRESHOLD_-16384}" ;;
  Darwin)
    if boot_id=$(/usr/sbin/sysctl -n kern.bootsessionuuid 2>/dev/null) && [ -n "$boot_id" ]; then
      export GUGU_SERVER_BOOT_ID="$boot_id"
    else
      unset GUGU_SERVER_BOOT_ID
      printf '%s\\n' '[server] Could not read boot identity; retaining locks conservatively.' >&2
    fi
    ;;
esac
if [ "\${1:-run}" = run ]; then
  if [ -z "\${GUGU_SERVER_HOME:-}" ]; then
    parent="$(dirname "$dir")"
    if [ "$(basename "$parent")" = versions ] && [ -f "$parent/../channel" ]; then
      GUGU_SERVER_HOME="$(cd "$parent/.." && pwd -P)"
    else
      GUGU_SERVER_HOME="$HOME/.gugu-server${suffix}"
    fi
    export GUGU_SERVER_HOME
  fi
  [ "$#" -gt 0 ] || set -- run
  exec "$dir/node/bin/node" --require "$dir/app/dist-electron/server-boot.cjs" "$dir/app/dist-electron/server.js" "$@"
fi
exec "$dir/node/bin/node" "$dir/app/dist-electron/server.js" "$@"
`
}

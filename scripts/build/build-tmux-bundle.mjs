// @@@bundle-tmux - Vendor a self-contained tmux into the app so agent hosting can default to tmux
// without the user having a system tmux. macOS can't fully-static-link (no static libSystem), so we
// copy the host tmux + its non-system dylibs and rewrite load paths to @executable_path (the dylibs
// sit next to the tmux binary in Resources/tmux-bundle/). install_name_tool invalidates the signature,
// so we ad-hoc re-sign. Verified: the 3 deps (libutf8proc/libncursesw/libevent_core) form a FLAT tree
// (each only links system libs), so one level of vendoring is enough.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const outDir = join(root, 'tmux-bundle')

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' })
}

function resolveTmux() {
  // GUGU_BUNDLE_TMUX overrides (explicit intent → fail loud later if the path is bad); else the tmux on
  // PATH. null = no tmux to vendor (caller skips gracefully so a tmux-less build machine stays green).
  const override = process.env.GUGU_BUNDLE_TMUX?.trim()
  if (override) return override
  try {
    return sh('/usr/bin/which', ['tmux']).trim()
  } catch {
    return null
  }
}

// Non-system dylib deps from `otool -L` (skip /usr/lib + /System + the binary's own id line).
function nonSystemDylibs(binPath) {
  const out = sh('/usr/bin/otool', ['-L', binPath])
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' ')[0])
    .filter((p) => p && !p.startsWith('/usr/lib') && !p.startsWith('/System'))
}

const tmuxSrc = resolveTmux()
if (!tmuxSrc) {
  // @@@bundle-tmux-skip - no system tmux on this build machine (e.g. CI). The bundle is a release-time
  // enhancement, not a hard build input, so skip+warn instead of failing the whole `build`. Remove any
  // stale bundle so the existence gates stay honest: electron-builder.cjs omits the extraResources entry
  // and desktop main leaves GUGU_TMUX_BIN unset → the app falls back to PATH `tmux` at runtime.
  console.warn('[build-tmux] no tmux found to vendor — skipping bundle (set GUGU_BUNDLE_TMUX to force)')
  rmSync(outDir, { recursive: true, force: true })
  process.exit(0)
}
console.log('vendoring tmux from:', tmuxSrc)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const tmuxOut = join(outDir, 'tmux')
copyFileSync(tmuxSrc, tmuxOut)
chmodSync(tmuxOut, 0o755)

if (process.platform === 'darwin') {
  // Flat tree (verified): tmux's non-system deps each only link system libs. Copy + relocate one level.
  const deps = nonSystemDylibs(tmuxSrc).filter((p) => p !== tmuxSrc)
  for (const dep of deps) {
    const name = basename(dep)
    const depOut = join(outDir, name)
    copyFileSync(dep, depOut)
    chmodSync(depOut, 0o644)
    // tmux references this dep by its absolute path -> point at @executable_path
    sh('/usr/bin/install_name_tool', ['-change', dep, `@executable_path/${name}`, tmuxOut])
    // the dep's own install id -> @executable_path (it sits beside the tmux executable)
    sh('/usr/bin/install_name_tool', ['-id', `@executable_path/${name}`, depOut])
  }

  // install_name_tool invalidates code signatures; ad-hoc re-sign everything.
  for (const name of ['tmux', ...deps.map((d) => basename(d))]) {
    sh('/usr/bin/codesign', ['-f', '-s', '-', join(outDir, name)])
  }

  // Fail loud if any homebrew/abs path survived in tmux's load commands.
  const leftover = nonSystemDylibs(tmuxOut).filter((p) => !p.startsWith('@'))
  if (leftover.length) {
    throw new Error(`tmux still references non-relocated dylibs: ${leftover.join(', ')}`)
  }

  const version = sh(tmuxOut, ['-V']).trim()
  console.log('bundled tmux ->', outDir, '|', version, '| deps:', deps.map((d) => basename(d)).join(', '))
} else {
  // @@@bundle-tmux-linux - ELF tmux links system libs (libc / libtinfo / libevent) present on any Linux
  // desktop target, so no dylib vendoring/relocation is needed — and otool/install_name_tool/codesign
  // are macOS Mach-O tools, absent on Linux (the otool ENOENT that used to fail `build:linux`). Copy the
  // binary as-is; the standard loader resolves the system .so at runtime. `tmux -V` here doubles as a
  // smoke check that the copied binary actually runs on this host.
  const version = sh(tmuxOut, ['-V']).trim()
  console.log('bundled tmux (linux, system-linked) ->', outDir, '|', version)
}

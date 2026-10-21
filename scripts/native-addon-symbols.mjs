import { execFileSync } from 'node:child_process'

const FORBIDDEN_PTY_EXPORTS = [
  { label: 'PtyFork', pattern: /PtyFork/ },
  // `nm -C` should expose Napi::, while the mangled pattern keeps the policy fail-loud if
  // a future nm invocation accidentally drops demangling again.
  { label: 'Napi::', pattern: /\bNapi::|_+ZN4Napi/ },
]

export function assertPtySymbolOutput(symbols, arch) {
  for (const { label, pattern } of FORBIDDEN_PTY_EXPORTS) {
    if (pattern.test(symbols)) {
      throw new Error(
        `[verify-packaged-natives] ${arch}: node-pty exposes C++ symbol '${label}', ` +
          'which can be interposed by another native addon',
      )
    }
  }
  if (!symbols.includes('_napi_register_module_v1')) {
    throw new Error(
      `[verify-packaged-natives] ${arch}: node-pty is missing its N-API module registration export`,
    )
  }
}

export function readPtyGlobalSymbols(ptyNative, { execFile = execFileSync } = {}) {
  return execFile('nm', ['-gUC', ptyNative], { encoding: 'utf8' })
}

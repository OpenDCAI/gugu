// Resolve a bundled `/assets/…` reference for the current runtime. #1285.
//
// Web (http/https): the renderer is served from the origin root, so a root-absolute
// `/assets/…` is correct at ANY route depth. A `./`-relative path breaks under deep routes
// like `/join/agent/<id>` — it resolves against the route, yielding `/join/agent/assets/…`
// (404), which crashed the public landing.
//
// Electron production (file://): there is no server root, so `/assets/…` would point at the
// filesystem root. The renderer is loaded from `dist/index.html` (loadFile) and Electron only
// ever sits at that index.html (no deep file:// routes), so a path relative to it (`./assets/…`)
// is correct. This branch keeps Electron's existing behaviour unchanged (no regression).
export function resolvePublicAssetUrl(url: string | null | undefined): string | null {
  const value = url?.trim()
  if (!value) return null
  if (/^(https?:|data:|blob:|file:)/i.test(value)) return value
  // Normalize a bundled asset reference stored in EITHER form — root-absolute `/assets/…` or
  // the previously-baked relative `./assets/…` — to the runtime-correct base. (Stored values
  // like agent preset avatars carry `./assets/…`; the landing must re-resolve them, #1285.)
  if (value.startsWith('/assets/') || value.startsWith('./assets/')) {
    const rootPath = value.startsWith('./') ? value.slice(1) : value
    const isFileProtocol = typeof window !== 'undefined' && window.location?.protocol === 'file:'
    return isFileProtocol ? `.${rootPath}` : rootPath
  }
  return value
}

export function publicAssetPath(path: string): string {
  return resolvePublicAssetUrl(path) ?? path
}

const empty = new Set([
  'Page.enable', 'Page.getFrameTree', 'Log.enable', 'Runtime.enable', 'Runtime.runIfWaitingForDebugger',
]);
const hasOnly = (params: Record<string, unknown>, keys: readonly string[]) => Object.keys(params).every(key => keys.includes(key));
const name = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const preferences: Record<string, readonly string[]> = {
  'prefers-color-scheme': ['light', 'dark', 'no-preference'],
  'prefers-reduced-motion': ['reduce', 'no-preference'],
  'forced-colors': ['active', 'none'],
  'prefers-contrast': ['more', 'less', 'custom', 'no-preference'],
};

/** Resource-owned observation/initialization, never a tool's page action or arbitrary script. */
export function pageProtocolMaintenance(method: string, params: Record<string, unknown>): boolean {
  if (empty.has(method)) return hasOnly(params, []);
  if (method === 'Page.setLifecycleEventsEnabled') return hasOnly(params, ['enabled']) && params.enabled === true;
  if (method === 'Page.addScriptToEvaluateOnNewDocument') {
    return hasOnly(params, ['source', 'worldName']) && params.source === '' && name(params.worldName);
  }
  if (method === 'Page.createIsolatedWorld') {
    return hasOnly(params, ['frameId', 'worldName', 'grantUniveralAccess']) && name(params.frameId)
      && name(params.worldName) && (params.grantUniveralAccess === undefined || params.grantUniveralAccess === true);
  }
  if (method === 'Network.enable') return hasOnly(params, []);
  if (method === 'Target.setAutoAttach') {
    return hasOnly(params, ['autoAttach', 'waitForDebuggerOnStart', 'flatten'])
      && params.autoAttach === true && params.waitForDebuggerOnStart === true && params.flatten === true;
  }
  if (method === 'Target.detachFromTarget') return hasOnly(params, ['sessionId']) && name(params.sessionId);
  if (method === 'Emulation.setEmulatedMedia') {
    if (!hasOnly(params, ['media', 'features']) || params.media !== '' || !Array.isArray(params.features) || params.features.length > 4) return false;
    const seen = new Set<string>();
    return params.features.every(feature => {
      if (!feature || typeof feature !== 'object' || !hasOnly(feature, ['name', 'value'])
        || typeof feature.name !== 'string' || typeof feature.value !== 'string' || seen.has(feature.name)
        || !Object.hasOwn(preferences, feature.name) || !preferences[feature.name]!.includes(feature.value)) return false;
      seen.add(feature.name); return true;
    });
  }
  return false;
}

/** The native tree, not an App-supplied frame identity. Child CDP sessions are already scoped by PageProtocol. */
export function pageTreeHasFrame(tree: unknown, frameId: unknown): boolean {
  if (!tree || typeof tree !== 'object') return false;
  const node = tree as { frame?: { id?: unknown }; childFrames?: unknown[] };
  return node.frame?.id === frameId || Array.isArray(node.childFrames) && node.childFrames.some(child => pageTreeHasFrame(child, frameId));
}

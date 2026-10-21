export function createCapacitorPlatformTestDouble() {
  return {
    kind: 'capacitor',
    capabilities: {
      directoryPicker: false,
      appVersion: false,
      appUpdates: false,
      agentRuntime: false,
      badge: false,
      clipboard: false,
      notifications: false,
      rendererCommandBridge: false,
    },
  }
}

export function createDesktopPlatformTestDouble() {
  return {
    kind: 'desktop',
    capabilities: {
      directoryPicker: true,
      appVersion: true,
      appUpdates: true,
      agentRuntime: true,
      badge: true,
      clipboard: true,
      notifications: true,
      rendererCommandBridge: true,
    },
  }
}

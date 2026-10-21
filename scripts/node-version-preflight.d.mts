export function readNodePin(rootDir?: string): string

export function assertNodeVersion(input?: {
  rootDir?: string
  currentVersion?: string
}): { current: string; pin: string }

export function runNodeVersionPreflight(rootDir?: string): { current: string; pin: string }

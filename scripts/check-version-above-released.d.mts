export function parseSemver(input?: unknown): {
  major: number
  minor: number
  patch: number
  prerelease: string | undefined
} | null

export function compareCore(a?: unknown, b?: unknown): number

export function isAboveReleased(localVersion?: unknown, releasedVersion?: unknown): boolean

export function readFeedVersion(yamlText?: unknown): string | null

export function stableFeedUrl(rootDir?: string): string

export function readLocalVersion(rootDir?: string): string

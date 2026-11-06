export function seedCacheDirectory(
  source: string | null,
  target: string,
  options?: { warn?: (message: string) => void },
): 'absent' | 'same-store' | 'seeded' | 'unavailable'

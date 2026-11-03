/**
 * 两个版本号比大小:数字段逐段比(0.2.49 < 0.2.50 < 0.3.0);`-beta.3` 这类后缀里的数字段在主版本相同时再比。
 * 返回 >0 = a 更新。
 */
export function compareServerVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = '', suffix = ''] = v.split(/-(.*)/s)
    return { main: main.split('.').map((n) => Number(n) || 0), suffix: suffix.split(/[.-]/).map((n) => Number(n) || 0), hasSuffix: suffix !== '' }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i += 1) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0)
    if (d !== 0) return d
  }
  // 同一个主版本:正式版比预发版新(0.3.0 > 0.3.0-beta.9),预发版之间按后缀里的数字比。
  if (x.hasSuffix !== y.hasSuffix) return x.hasSuffix ? -1 : 1
  for (let i = 0; i < Math.max(x.suffix.length, y.suffix.length); i += 1) {
    const d = (x.suffix[i] ?? 0) - (y.suffix[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}


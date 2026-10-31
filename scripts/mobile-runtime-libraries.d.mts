export interface MobileElf { needed: string[]; soname: string | null }
export interface MobileLibraryAlias { name: string; target: string }
export function inspectMobileElf(path: string, readelf?: string): MobileElf
export function mobileRuntimeClosure(node: Pick<MobileElf, 'needed'>, libraries: ReadonlyMap<string, MobileElf>, aliases: MobileLibraryAlias[]): {
  files: string[]
  aliases: MobileLibraryAlias[]
  edges: { requested: string; file: string; soname: string | null }[]
}

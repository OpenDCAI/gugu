export type ButtonKind =
  | 'adopted'
  | 'full-handrolled'
  | 'hover-only'
  | 'no-feedback'
  | 'no-class'
  | 'unresolved'

export declare function stripComments(source: string): string
export declare function buttonTags(rawSource: string): string[]
export declare function resolveClasses(tag: string, source: string, fromFile?: string): string | null
/** classes 是解析出的类名串；unresolved 列出回查不到的类名来源 —— 它必须被调用方看见，
 *  否则一次解析失败会静默贡献一个「没有 bg-」的串，与「真的没有背景」同形。 */
export declare function resolveDetail(
  tag: string,
  source: string,
  fromFile?: string,
  depth?: number,
): { classes: string | null, unresolved: string[] }
export declare function classify(
  tag: string,
  source: string,
  fromFile?: string,
  cssIndex?: Map<string, { hover: boolean, active: boolean }>,
): ButtonKind
export declare function buildCssIndex(root: string): Map<string, { hover: boolean, active: boolean }>
export declare function scan(root: string): {
  counts: Record<ButtonKind | 'total', number>
  perFile: Map<string, Partial<Record<ButtonKind, number>>>
}

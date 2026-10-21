export declare const IM_SERVER_PATH: string
export declare const DIRECT_REST_ALLOWLIST: Readonly<Record<string, readonly string[]>>
export interface ImServerDirectAccessViolation {
  line: number
  rule: string
  detail: string
}
export declare function findImServerDirectAccessViolations(source: string): ImServerDirectAccessViolation[]

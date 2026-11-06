export function browserShardPlan(argv: string[], cores: number): {
  args: string[]
  total: number
  shards: Array<{ index: number; total: number }>
}

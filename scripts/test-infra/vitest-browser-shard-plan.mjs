const MAX_SHARDS = 16

/** Compose disjoint CI groups with the existing per-runner browser processes. */
export function browserShardPlan(argv, cores) {
  const args = [], options = new Map()
  for (const arg of argv) {
    const match = /^(--shard-group|--shards-per-group)=(.*)$/.exec(arg)
    if (!match) { args.push(arg); continue }
    if (options.has(match[1])) throw new Error('Duplicate browser shard option: ' + match[1])
    options.set(match[1], match[2])
  }
  const filtered = args.some((arg, i) => !arg.startsWith('-') && args[i - 1] !== '--project')
  const grouped = options.size > 0
  let group = 1, groups = 1
  let total = filtered ? 1 : Math.max(1, Math.min(MAX_SHARDS, Math.floor(cores) || 1))
  if (grouped) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(options.get('--shard-group') ?? '')
    const count = options.get('--shards-per-group') ?? ''
    if (!match || !/^[1-9]\d*$/.test(count)) throw new Error('Grouped browser runs require --shard-group=i/n and --shards-per-group=k')
    group = Number(match[1]); groups = Number(match[2]); total = Number(count)
    if (group > groups || total * groups > MAX_SHARDS) throw new Error('Invalid or excessive browser shard group')
    if (filtered || args.some(arg => arg === '--shard' || arg.startsWith('--shard='))) {
      throw new Error('Browser shard groups require a full project without a separate --shard')
    }
  }
  const globalTotal = total * groups
  return {
    args, total,
    shards: Array.from({ length: total }, (_, i) => ({ index: (group - 1) * total + i + 1, total: globalTotal })),
  }
}

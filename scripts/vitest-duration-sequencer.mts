import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

const durations = JSON.parse(readFileSync(new URL('./ci-unit-durations.json', import.meta.url), 'utf8')) as Record<string, number>

// Experiment: balance measured execution time while retaining equal file counts for import overhead.
export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const bins = Array.from({ length: count }, (_, shard) => ({
      capacity: Math.floor(files.length / count) + (shard < files.length % count ? 1 : 0),
      duration: 0,
      files: [] as TestSpecification[],
    }))
    const key = (file: TestSpecification) => `${file.project.name}:${relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/')}`
    const duration = (file: TestSpecification) => durations[key(file)] ?? 0
    const ordered = [...files].sort((a, b) => duration(b) - duration(a) || key(a).localeCompare(key(b)))
    for (const file of ordered) {
      const bin = bins.filter((candidate) => candidate.files.length < candidate.capacity)
        .sort((a, b) => a.duration - b.duration)[0]
      if (!bin) throw new Error('Duration sharding ran out of capacity')
      bin.files.push(file)
      bin.duration += duration(file)
    }
    console.log('[duration-shards]', JSON.stringify(bins.map((bin) => ({ files: bin.files.length, measuredMs: bin.duration }))))
    return bins[index - 1].files
  }
}

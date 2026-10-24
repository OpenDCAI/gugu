import { execFileSync, spawn } from 'node:child_process'
import { cpus, totalmem } from 'node:os'

// Temporary experiment instrumentation: command arguments and environment values are never logged.
const started = performance.now()
console.log('[ci-build-profile] ready', JSON.stringify({ cpus: cpus().length, memoryMiB: totalmem() / 2 ** 20 }))
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' })
function sample() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => {
      const [pid, parent, cpu, rss] = line.trim().split(/\s+/).map(Number)
      return { pid, parent, cpu, rss }
    })
  const descendants = new Set([child.pid])
  for (let size = -1; size !== descendants.size;) {
    size = descendants.size
    for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid)
  }
  const own = rows.filter((row) => descendants.has(row.pid))
  const vm = Object.fromEntries(execFileSync('vm_stat', { encoding: 'utf8' }).split('\n')
    .flatMap((line) => {
      const match = /^(.+):\s+(\d+)\./.exec(line)
      return match ? [[match[1], Number(match[2])]] : []
    }))
  console.log('[ci-build-profile]', JSON.stringify({
    seconds: Math.round((performance.now() - started) / 1000),
    processes: own.length,
    cpuPercent: Math.round(own.reduce((sum, row) => sum + row.cpu, 0)),
    rssMiB: Math.round(own.reduce((sum, row) => sum + row.rss, 0) / 1024),
    vm,
    swap: execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim(),
  }))
}
sample()
const timer = setInterval(sample, 5000)
child.on('error', (error) => { clearInterval(timer); throw error })
child.on('exit', (code, signal) => {
  clearInterval(timer)
  sample()
  console.log('[ci-build-profile] done', JSON.stringify({ seconds: (performance.now() - started) / 1000, code, signal }))
  process.exitCode = code ?? 1
})

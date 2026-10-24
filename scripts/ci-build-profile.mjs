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
  const vmRaw = execFileSync('vm_stat', { encoding: 'utf8' })
  const vm = Object.fromEntries(vmRaw.split('\n')
    .flatMap((line) => {
      const match = /^(.+):\s+(\d+)\./.exec(line)
      return match ? [[match[1], Number(match[2])]] : []
    }))
  // iostat's first row is since boot; use its second row for a one-second CPU interval.
  const cpuColumns = execFileSync('/usr/sbin/iostat', ['-c', '2', '-w', '1'], { encoding: 'utf8' })
    .trim().split('\n').at(-1).trim().split(/\s+/).slice(-6).map(Number)
  console.log('[ci-build-profile]', JSON.stringify({
    seconds: Math.round((performance.now() - started) / 1000),
    processes: own.length,
    cpuPercent: Math.round(own.reduce((sum, row) => sum + row.cpu, 0)),
    rssMiB: Math.round(own.reduce((sum, row) => sum + row.rss, 0) / 1024),
    systemCpu: { userPercent: cpuColumns[0], systemPercent: cpuColumns[1], idlePercent: cpuColumns[2] },
    vmPageSizeBytes: Number(/page size of (\d+) bytes/.exec(vmRaw)?.[1]),
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

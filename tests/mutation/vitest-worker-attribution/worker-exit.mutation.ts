import { test } from 'vitest'

test('kills its worker after the case starts', () => {
  process.kill(process.pid, 'SIGKILL')
})

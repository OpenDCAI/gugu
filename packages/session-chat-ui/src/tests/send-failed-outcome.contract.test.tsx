/** @jsxImportSource solid-js */
import { describe, expect, it } from 'vitest'
import { turnOutcomeUnitDef } from '@session-chat/components/rows/turn-outcome/turn-outcome.def'
import type { TurnOutcomeItem } from '@session-chat/model'
import { makeContractCtx, renderAndMeasureUnit } from './contract'

describe('an input still in host custody cannot be restored and sent twice', () => {
  it.each([240, 640])('shows one failure badge with matching measured height at width %s', async width => {
    const data: TurnOutcomeItem = { kind: 'turn-outcome', id: 'input:outcome', turnId: 'input',
      outcome: { kind: 'error', reason: 'send_failed' }, prompt: 'input still queued' }
    let text = '', buttons = 0
    const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, data, makeContractCtx({ width }), host => {
      text = host.querySelector('[data-slot="turn-outcome-badge"]')?.textContent ?? ''
      buttons = host.querySelectorAll('button').length
      return { buttons }
    }, { onRestorePrompt: () => {} })
    expect(text).toBe('Could not send')
    expect(buttons).toBe(0)
    expect(reading.dom).toBe(reading.computed)
  })

  it('keeps restore available for an ordinary prompt failure', async () => {
    let buttons = 0
    const reading = await renderAndMeasureUnit(turnOutcomeUnitDef, { kind: 'turn-outcome', id: 'reply:outcome', turnId: 'reply',
      outcome: { kind: 'error', reason: 'prompt_failed' }, prompt: 'already sent' }, makeContractCtx({ width: 640 }), host => {
      buttons = host.querySelectorAll('button').length
      return { buttons }
    }, { onRestorePrompt: () => {} })
    expect(buttons).toBe(1)
    expect(reading.dom).toBe(reading.computed)
  })
})

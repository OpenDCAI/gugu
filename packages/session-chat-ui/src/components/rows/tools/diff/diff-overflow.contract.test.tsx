/** @jsxImportSource solid-js */
import { textFilePatch } from '@gugu/session-core/lib';

import { diffBodyCard } from './diff.css'
import { diffUnitDef } from './diff.def'
import { makeContractCtx, renderAndMeasureUnit } from '../../../../tests/contract'
import { expect, it } from 'vitest'

it('keeps a long diff line readable through the body scroll container', async () => {
  const item = {
    kind: 'diff' as const,
    id: 'long-diff',
    patches: [textFilePatch('packages/session-chat-ui/src/components/rows/tools/diff/diff-lines.ts', 'before', `after ${'x'.repeat(400)}`)],

    status: 'done' as const
  }

  const reading = await renderAndMeasureUnit(
    diffUnitDef,
    item,
    makeContractCtx({ width: 320 }),
    (host) => {
      const body = host.querySelector<HTMLElement>(`.${diffBodyCard}`)
      return {
        bodyFound: body ? 1 : 0,
        horizontalOverflow: body ? body.scrollWidth - body.clientWidth : 0,
        overflowXAuto: body && getComputedStyle(body).overflowX === 'auto' ? 1 : 0
      }
    }
  )

  expect(reading.dom).toBe(reading.computed)
  expect(reading.inspected.bodyFound).toBe(1)
  expect(reading.inspected.horizontalOverflow).toBeGreaterThan(0)
  expect(reading.inspected.overflowXAuto).toBe(1)
})

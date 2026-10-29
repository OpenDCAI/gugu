import { describe, expect, it } from 'vitest'
import { visibleTools, withheldToolResult } from './withheld-tools'

const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } })

describe('tools an integration does not hand to sessions', () => {
  const upstream = ['taxi_estimate', 'taxi_create_order', 'maps_textsearch', 'taxi_cancel_order'].map(tool)

  it('drops the withheld tools from the list and keeps the others in order', () => {
    const names = visibleTools(upstream, new Set(['taxi_create_order', 'taxi_cancel_order'])).map((t) => t.name)
    expect(names).toEqual(['taxi_estimate', 'maps_textsearch'])
  })

  it('hands everything over when nothing is withheld', () => {
    expect(visibleTools(upstream, undefined)).toEqual(upstream)
    expect(visibleTools(upstream, new Set())).toEqual(upstream)
  })

  it('answers a call to a withheld tool with an error that names it, without forwarding', () => {
    const hidden = new Set(['taxi_create_order'])
    const refused = withheldToolResult('taxi_create_order', hidden)
    expect(refused?.isError).toBe(true)
    expect(JSON.stringify(refused?.content)).toContain('taxi_create_order')
    expect(withheldToolResult('taxi_estimate', hidden)).toBeNull()
    expect(withheldToolResult('taxi_create_order', undefined)).toBeNull()
  })
})

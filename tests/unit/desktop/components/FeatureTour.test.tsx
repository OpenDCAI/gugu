// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
vi.mock('../../../../apps/desktop/src/components/ui/Dialog', () => {
  const content = ({ children }: { children?: ReactNode }) => children
  return { Dialog: { Root: content, Portal: content, Backdrop: () => null, Viewport: content,
    Popup: content, Title: content, Description: content } }
})

const { FeatureTour } = await import('../../../../apps/desktop/src/components/productTour/FeatureTour')

beforeEach(() => {
  // Reduced motion keeps the player still while inspecting the selected media.
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
})
afterEach(() => vi.unstubAllGlobals())

describe('feature film media after removing the obsolete modes film', () => {
  it.each([[0, 1], [1, 3], [2, 4]])('pairs film %i with source, poster and captions from asset %i', async (index, asset) => {
    const h = createReactHarness()
    try {
      await h.render(createNode(FeatureTour, { index, children: null, onSelect: vi.fn(), onClose: vi.fn() }))
      const video = h.container.querySelector('video')!
      expect(video.getAttribute('src')).toContain(`feature-${asset}.webm`)
      expect(video.getAttribute('poster')).toContain(`feature-${asset}.webp`)
      expect(video.querySelector('track')?.getAttribute('src')).toContain(`feature-${asset}.vtt`)
    } finally { h.cleanup() }
  })
})

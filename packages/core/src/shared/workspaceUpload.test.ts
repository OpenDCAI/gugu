import { describe, expect, it } from 'vitest'
import { workspaceFileText } from './workspaceUpload.mjs'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('workspaceFileText: is a file on a disk text', () => {
  it('an SVG is, though its type says image', () => {
    expect(workspaceFileText('s.svg', bytes('<svg/>'))?.text).toBe('<svg/>')
  })

  it('another image is not, whatever its bytes', () => {
    expect(workspaceFileText('a.png', bytes('plain'))).toBeNull()
  })

  it('a name that says nothing leaves it to the bytes', () => {
    expect(workspaceFileText('Makefile', bytes('all:'))?.text).toBe('all:')
    expect(workspaceFileText('Makefile', new Uint8Array([97, 0]))).toBeNull()
  })
})

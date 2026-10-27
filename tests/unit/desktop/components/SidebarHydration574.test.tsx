// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSessionTree, type SessionTreeItem, type SessionTreeNode } from '../../../../apps/desktop/src/session/renderer/features/sessions/session-tree'
import { createReactHarness } from '../../../support/testHarness'

type Entry = SessionTreeItem & { title: string }
const flatten = (roots: SessionTreeNode<Entry>[]): Entry[] =>
  roots.flatMap((node) => [node.item, ...flatten(node.children)])

afterEach(() => vi.restoreAllMocks())

describe('sidebar snapshots converging during startup (#574)', () => {
  it('places a repeated root only once and uses its latest snapshot', () => {
    const roots = buildSessionTree([{ id: 'root', title: 'first' }, { id: 'root', title: 'latest' }])
    expect(roots.map((node) => node.item)).toEqual([{ id: 'root', title: 'latest' }])
  })

  it('attaches a repeated child only once', () => {
    const child = { id: 'child', title: 'child', parentSessionId: 'root' }
    const roots = buildSessionTree([{ id: 'root', title: 'root' }, child, child])
    expect(flatten(roots).map((entry) => entry.id)).toEqual(['root', 'child'])
  })

  it('uses the latest parent when overlapping snapshots disagree', () => {
    const roots = buildSessionTree([
      { id: 'old-parent', title: 'old' },
      { id: 'new-parent', title: 'new' },
      { id: 'child', title: 'first', parentSessionId: 'old-parent' },
      { id: 'child', title: 'latest', parentSessionId: 'new-parent' },
    ])
    expect(roots[0].children).toEqual([])
    expect(roots[1].children.map((node) => node.item)).toEqual([
      { id: 'child', title: 'latest', parentSessionId: 'new-parent' },
    ])
  })

  it('removes old task DOM when repeated startup rows leave the directory', async () => {
    const harness = createReactHarness()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const old = ['weather', 'research', 'observation'].map((id) => ({ id, title: id, parentSessionId: 'assistant' }))
    const current = [{ id: 'project', title: 'Project' }, { id: 'current-task', title: 'Current task' }]
    const render = (entries: Entry[]) => harness.render(
      <div>{flatten(buildSessionTree(entries)).map((entry) => <div key={entry.id} data-task-row={entry.id}>{entry.title}</div>)}</div>,
    )
    try {
      await render([current[0], { id: 'assistant', title: 'Assistant' }, ...old.flatMap((entry) => [entry, entry]), current[1]])
      await render(current)
      expect(Array.from(harness.container.querySelectorAll('[data-task-row]')).map((node) => node.getAttribute('data-task-row')))
        .toEqual(['project', 'current-task'])
      expect(errors).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })
})

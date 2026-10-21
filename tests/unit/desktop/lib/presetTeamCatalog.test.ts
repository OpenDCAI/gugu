import { beforeEach, describe, expect, it, vi } from 'vitest'
const from = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { from },
}))
import { Compass } from '../../../../apps/desktop/src/lib/icons'
import {
  loadPresetTeamCatalog,
  parsePresetTeamCatalogRows,
  resolvePresetTeamIcon,
} from '../../../../apps/desktop/src/lib/presetTeamCatalog'
function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-team',
    sort_order: 1,
    name: 'Test Team',
    best_for: 'A concrete task',
    deliverable: 'A reviewable result',
    description: 'A focused catalog fixture',
    starter_prompt: 'Start with evidence.',
    domain: 'Testing',
    provenance: 'Test fixture only',
    icon_token: 'compass',
    accent_var: 'var(--team-test)',
    icon_var: 'var(--team-test-soft)',
    roles: [{
      key: 'editor',
      title: 'Editor',
      responsibility: ' Preserve responsibility bytes. ',
      persona: ' Preserve persona bytes.\n',
      engine: 'codex',
      avatarSeed: 'test-editor',
    }],
    group_prompt: 'Preserve the group prompt.',
    tags: ['fixture'],
    ...overrides,
  }
}
function arrangeQuery(data: unknown, error: { message: string } | null = null) {
  const order = vi.fn().mockResolvedValue({ data, error })
  const select = vi.fn().mockReturnValue({ order })
  from.mockReturnValue({ select })
  return { select, order }
}
describe('preset-team catalog renderer contract', () => {
  beforeEach(() => {
    from.mockReset()
  })
  it('loads declared columns in curated order and maps a row without changing role bytes', async () => {
    const { select, order } = arrangeQuery([catalogRow()])
    const entries = await loadPresetTeamCatalog()
    expect(from).toHaveBeenCalledWith('preset_teams')
    expect(select).toHaveBeenCalledWith([
      'id',
      'sort_order',
      'name',
      'best_for',
      'deliverable',
      'description',
      'starter_prompt',
      'domain',
      'provenance',
      'icon_token',
      'accent_var',
      'icon_var',
      'roles',
      'group_prompt',
      'tags',
    ].join(', '))
    expect(order).toHaveBeenCalledWith('sort_order', { ascending: true })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'test-team',
      sortOrder: 1,
      bestFor: 'A concrete task',
      starterPrompt: 'Start with evidence.',
      iconToken: 'compass',
      icon: Compass,
      roles: [{
        responsibility: ' Preserve responsibility bytes. ',
        persona: ' Preserve persona bytes.\n',
        engine: 'codex',
        avatarSeed: 'test-editor',
      }],
    })
  })
  it('fails loudly on a PostgREST error instead of returning catalog data', async () => {
    arrangeQuery(null, { message: 'permission denied for table preset_teams' })
    await expect(loadPresetTeamCatalog()).rejects.toThrow(
      '[preset-team-catalog] read failed: permission denied for table preset_teams',
    )
  })
  it('adds catalog context when the request itself rejects', async () => {
    const order = vi.fn().mockRejectedValue(new Error('network offline'))
    from.mockReturnValue({ select: () => ({ order }) })
    await expect(loadPresetTeamCatalog()).rejects.toThrow(
      '[preset-team-catalog] read failed: network offline',
    )
  })
  it.each([
    ['null data', null, 'response data must be an array'],
    ['empty data', [], 'catalog is empty'],
  ])('fails loudly on %s', async (_case, data, message) => {
    arrangeQuery(data)
    await expect(loadPresetTeamCatalog()).rejects.toThrow(message)
  })
  it('fails loudly on an unknown icon token and names it', () => {
    expect(() => resolvePresetTeamIcon('made-up-icon')).toThrow(
      '[preset-team-catalog] unknown icon_token "made-up-icon"',
    )
    expect(() => parsePresetTeamCatalogRows([
      catalogRow({ icon_token: 'made-up-icon' }),
    ])).toThrow('unknown icon_token "made-up-icon"')
  })
  it('rejects cloud or unknown engines instead of normalizing them', () => {
    expect(() => parsePresetTeamCatalogRows([
      catalogRow({ roles: [{
        key: 'cloud',
        title: 'Cloud role',
        responsibility: 'Do work',
        persona: 'Stay focused',
        engine: 'gugu-cloud',
        avatarSeed: 'cloud-role',
      }] }),
    ])).toThrow('unsupported local engine "gugu-cloud"')
  })
  it('rejects empty roles, duplicate ids, and non-increasing sort order', () => {
    expect(() => parsePresetTeamCatalogRows([catalogRow({ roles: [] })]))
      .toThrow('roles must be a non-empty array')
    expect(() => parsePresetTeamCatalogRows([
      catalogRow(),
      catalogRow({ sort_order: 2 }),
    ])).toThrow('duplicate team id "test-team"')
    expect(() => parsePresetTeamCatalogRows([
      catalogRow({ id: 'first', sort_order: 2 }),
      catalogRow({ id: 'second', sort_order: 1 }),
    ])).toThrow('rows are not strictly ordered by sort_order')
  })
})

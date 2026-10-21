import type { ComponentType } from 'react'
import {
  AGENT_TYPES,
  type SelectableAgentType,
} from '@gugu/core/shared/enums/agentTypeModels'
import {
  Activity,
  AlertTriangle,
  Checklist,
  Compass,
  Eye,
  FileText,
  FolderOpen,
  MessageSquare,
  Shield,
  Terminal,
  Users,
  type IconProps,
} from './icons'
import { dataClient } from './supabase'

export type PresetTeamCatalogIcon = ComponentType<IconProps>

const ICON_BY_TOKEN = {
  activity: Activity,
  'alert-triangle': AlertTriangle,
  checklist: Checklist,
  compass: Compass,
  eye: Eye,
  'file-text': FileText,
  'folder-open': FolderOpen,
  'message-square': MessageSquare,
  shield: Shield,
  terminal: Terminal,
  users: Users,
} as const satisfies Record<string, PresetTeamCatalogIcon>

export type PresetTeamIconToken = keyof typeof ICON_BY_TOKEN

export interface PresetTeamCatalogRole {
  key: string
  title: string
  responsibility: string
  persona: string
  engine: SelectableAgentType
  avatarSeed: string
}

export interface PresetTeamCatalogEntry {
  id: string
  sortOrder: number
  name: string
  bestFor: string
  deliverable: string
  description: string
  starterPrompt: string
  domain: string
  provenance: string
  iconToken: PresetTeamIconToken
  icon: PresetTeamCatalogIcon
  accentVar: string
  iconVar: string
  roles: PresetTeamCatalogRole[]
  groupPrompt: string
  tags: string[]
}

interface PresetTeamCatalogQueryResult {
  data: unknown
  error: { message: string } | null
}

export interface PresetTeamCatalogClient {
  from(table: 'preset_teams'): {
    select(columns: string): {
      order(
        column: 'sort_order',
        options: { ascending: true },
      ): PromiseLike<PresetTeamCatalogQueryResult>
    }
  }
}

const CATALOG_COLUMNS = [
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
].join(', ')

type UnknownRecord = Record<string, unknown>

function requireRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[preset-team-catalog] ${path} must be an object`)
  }
  return value as UnknownRecord
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[preset-team-catalog] ${path} must be a non-empty string`)
  }
  return value
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`[preset-team-catalog] ${path} must be a positive integer`)
  }
  return value as number
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`[preset-team-catalog] ${path} must be an array`)
  }
  return value.map((item, index) => requireNonEmptyString(item, `${path}[${index}]`))
}

function requireLocalEngine(value: unknown, path: string): SelectableAgentType {
  const engine = requireNonEmptyString(value, path)
  if (!AGENT_TYPES.includes(engine as SelectableAgentType)) {
    throw new Error(`[preset-team-catalog] ${path} has unsupported local engine "${engine}"`)
  }
  return engine as SelectableAgentType
}

export function resolvePresetTeamIcon(tokenValue: unknown): {
  token: PresetTeamIconToken
  icon: PresetTeamCatalogIcon
} {
  const token = requireNonEmptyString(tokenValue, 'icon_token')
  if (!(token in ICON_BY_TOKEN)) {
    throw new Error(`[preset-team-catalog] unknown icon_token "${token}"`)
  }
  const knownToken = token as PresetTeamIconToken
  return { token: knownToken, icon: ICON_BY_TOKEN[knownToken] }
}

function parseRole(value: unknown, rowIndex: number, roleIndex: number): PresetTeamCatalogRole {
  const path = `rows[${rowIndex}].roles[${roleIndex}]`
  const role = requireRecord(value, path)
  return {
    key: requireNonEmptyString(role.key, `${path}.key`),
    title: requireNonEmptyString(role.title, `${path}.title`),
    responsibility: requireNonEmptyString(role.responsibility, `${path}.responsibility`),
    persona: requireNonEmptyString(role.persona, `${path}.persona`),
    engine: requireLocalEngine(role.engine, `${path}.engine`),
    avatarSeed: requireNonEmptyString(role.avatarSeed, `${path}.avatarSeed`),
  }
}

function parseRow(value: unknown, index: number): PresetTeamCatalogEntry {
  const path = `rows[${index}]`
  const row = requireRecord(value, path)
  const rolesValue = row.roles
  if (!Array.isArray(rolesValue) || rolesValue.length === 0) {
    throw new Error(`[preset-team-catalog] ${path}.roles must be a non-empty array`)
  }
  const { token: iconToken, icon } = resolvePresetTeamIcon(row.icon_token)

  return {
    id: requireNonEmptyString(row.id, `${path}.id`),
    sortOrder: requirePositiveInteger(row.sort_order, `${path}.sort_order`),
    name: requireNonEmptyString(row.name, `${path}.name`),
    bestFor: requireNonEmptyString(row.best_for, `${path}.best_for`),
    deliverable: requireNonEmptyString(row.deliverable, `${path}.deliverable`),
    description: requireNonEmptyString(row.description, `${path}.description`),
    starterPrompt: requireNonEmptyString(row.starter_prompt, `${path}.starter_prompt`),
    domain: requireNonEmptyString(row.domain, `${path}.domain`),
    provenance: requireNonEmptyString(row.provenance, `${path}.provenance`),
    iconToken,
    icon,
    accentVar: requireNonEmptyString(row.accent_var, `${path}.accent_var`),
    iconVar: requireNonEmptyString(row.icon_var, `${path}.icon_var`),
    roles: rolesValue.map((role, roleIndex) => parseRole(role, index, roleIndex)),
    groupPrompt: requireNonEmptyString(row.group_prompt, `${path}.group_prompt`),
    tags: requireStringArray(row.tags, `${path}.tags`),
  }
}

export function parsePresetTeamCatalogRows(value: unknown): PresetTeamCatalogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('[preset-team-catalog] response data must be an array')
  }
  if (value.length === 0) {
    throw new Error('[preset-team-catalog] catalog is empty')
  }

  const entries = value.map(parseRow)
  const seenIds = new Set<string>()
  let previousSortOrder = 0
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new Error(`[preset-team-catalog] duplicate team id "${entry.id}"`)
    }
    if (entry.sortOrder <= previousSortOrder) {
      throw new Error('[preset-team-catalog] rows are not strictly ordered by sort_order')
    }
    seenIds.add(entry.id)
    previousSortOrder = entry.sortOrder
  }
  return entries
}

export async function loadPresetTeamCatalog(
  client: PresetTeamCatalogClient = dataClient as unknown as PresetTeamCatalogClient,
): Promise<PresetTeamCatalogEntry[]> {
  let result: PresetTeamCatalogQueryResult
  try {
    result = await client
      .from('preset_teams')
      .select(CATALOG_COLUMNS)
      .order('sort_order', { ascending: true })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`[preset-team-catalog] read failed: ${detail}`)
  }

  if (result.error) {
    throw new Error(`[preset-team-catalog] read failed: ${result.error.message}`)
  }
  return parsePresetTeamCatalogRows(result.data)
}

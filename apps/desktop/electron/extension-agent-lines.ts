import { join } from 'node:path'
import type { ExtensionSkill } from '@gugu/session-core/agents/plugins'
import type { ExtensionAgentApp } from './extension-session-mcp'

/** The same capability description at session opening and after the session installs an App. */
export const appLine = (app: ExtensionAgentApp) => `- ${app.name} (${app.extensionId}): ${app.instructions}`
export const skillLine = (skill: ExtensionSkill) => `- ${skill.name} (App ${skill.extensionId}): ${skill.description}\n  ${join(skill.dir, 'SKILL.md')}`

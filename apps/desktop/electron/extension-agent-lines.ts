import { join } from 'node:path'
import type { ExtensionSkill } from '@gugu/session-core/agents/plugins'
import type { ExtensionAgentApp } from './extension-session-mcp'

/** The same capability description at session opening and after the session installs an App. */
export const appLine = (app: ExtensionAgentApp) => `- ${app.name} (${app.extensionId}): ${app.instructions}`
export const skillLine = (skill: ExtensionSkill) => `- ${skill.name} (App ${skill.extensionId}): ${skill.description}\n  ${join(skill.dir, 'SKILL.md')}`
export const skillUseLine = (skill: ExtensionSkill) =>
  `For the rest of this conversation, when a request fits the ${skill.name} skill above (${skill.description}), ` +
  `read its SKILL.md first instead of working it out with your own tools; the request does not have to name the App.`

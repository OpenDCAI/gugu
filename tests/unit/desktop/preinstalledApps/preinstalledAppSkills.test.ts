// 预装 App 的 skill 要按产品的读法读得出来:产品用 readExtensionSkills 把 SKILL.md 的 frontmatter 当 YAML 读,读不出的那份
// 不挂、说一句(onProblem,#7189;以前是整个 App 的 skill 一起丢),会话照开(extensionAgentPrograms)。description 里有「: 」没加引号,YAML 就读不出:
// 群文件夹那份 skill 这样丢过,A/B 重跑 72 次 agent 一次都没见到它,别的测试全绿(10-12)。
// 带 skill 的咕咕办公 10-16 搬去了市场(索引仓 sources/office),现在的预装 App 没有一个带 skill;这道检查留着管以后带 skill 的,
// 判据本身由下面现写的一份 skill 证明会读、会拒。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readExtensionSkills } from '../../../../apps/desktop/electron/extension-session-mcp'

const root = resolve(__dirname, '../../../../apps/desktop/preinstalled-apps')
const apps = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const manifest = JSON.parse(readFileSync(join(root, entry.name, 'manifest.json'), 'utf8')) as { id: string; contributes?: { skills?: string } }
    return { id: manifest.id, skillsDir: manifest.contributes?.skills ? join(root, entry.name, manifest.contributes.skills) : null }
  })
const withSkills = apps.flatMap((app) => (app.skillsDir ? [{ id: app.id, skillsDir: app.skillsDir }] : []))

/** One skill folder written now, its description as given (quoted or not). */
function skillsDirWith(description: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-preinstalled-skill-'))
  mkdirSync(join(dir, 'files'))
  writeFileSync(join(dir, 'files', 'SKILL.md'), `---\nname: files\ndescription: ${description}\n---\n\nRead the file, then change it.\n`)
  return dir
}

const sentence = 'Before reading or changing a file in a chat\'s folder: download it, read and change it, save it back as its next version.'

describe('every preinstalled App\'s skills read the way the product reads them', () => {
  it('the check reads a description with 「: 」 whole when it is quoted, and reports the one that is not (control)', () => {
    const problems: string[] = []
    const [skill, ...more] = readExtensionSkills('demo', skillsDirWith(JSON.stringify(sentence)), (message) => problems.push(message))
    expect(problems).toEqual([])
    expect(more).toEqual([])
    expect(skill!.description).toBe(sentence)
    const refused: string[] = []
    readExtensionSkills('demo', skillsDirWith(sentence), (message) => refused.push(message))
    expect(refused).toHaveLength(1)
  })

  it('each preinstalled App with skills: every <folder>/SKILL.md gives one skill, with a description', () => {
    for (const { id, skillsDir } of withSkills) {
      const folders = readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
        .map((entry) => join(skillsDir, entry.name))
      // A preinstalled App says nothing when its skills are read: a problem here is a SKILL.md the product leaves out.
      const problems: string[] = []
      const skills = readExtensionSkills(id, skillsDir, (message) => problems.push(message))
      expect(problems, id).toEqual([])
      expect(skills.map((skill) => skill.dir).sort(), id).toEqual(folders.sort())
      for (const skill of skills) expect(skill.description, id).not.toBe('')
    }
  })
})

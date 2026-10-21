export function normalizeAgentDisplayName(displayName: string): string {
  const name = displayName.trim()
  if (!name) throw new Error('Agent display name is required')
  return name
}

export function normalizeAgentProjectPath(projectPath: string | null | undefined): string | null {
  const path = projectPath?.trim() || ''
  if (!path) return null
  if (!isAbsoluteProjectPath(path)) {
    throw new Error('项目目录必须是设备上的绝对路径，请等待目录加载完成后再选择。')
  }
  return path
}

function isAbsoluteProjectPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
}

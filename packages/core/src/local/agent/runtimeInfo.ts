export interface JsonlSearchResult {
  path?: string
  dirs_searched: number
  dirs_missing: number
  files_scanned: number
  titles_found?: string[]
}

export interface RuntimeInfoOptions {
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

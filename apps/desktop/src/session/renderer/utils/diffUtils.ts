/**
 * Map file extensions to editor language IDs (the keys of lib/codemirror/languages.ts).
 * They differ from Prism's in some cases
 */
export function getEditorLanguageId(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    jsonc: 'jsonc',
    xml: 'xml',
    svg: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    sql: 'sql',
    md: 'markdown',
    markdown: 'markdown',
    vue: 'vue',
    svelte: 'svelte',
    dart: 'dart',
    lua: 'lua',
    perl: 'perl',
    r: 'r',
    matlab: 'matlab',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    toml: 'toml',
    ini: 'ini',
    properties: 'properties',
    log: 'plaintext',
    txt: 'plaintext',
  };

  // Check for special file names
  if (filePath.toLowerCase().includes('dockerfile')) return 'dockerfile';
  if (filePath.toLowerCase().includes('makefile')) return 'makefile';

  return langMap[ext] || 'plaintext';
}

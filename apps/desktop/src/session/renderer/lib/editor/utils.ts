const MARKDOWN_EXTENSIONS = ['md', 'mdx'];

/** Returns true if the file path points to a markdown file. */
export function isMarkdownPath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? MARKDOWN_EXTENSIONS.includes(ext) : false;
}

/** Alias for {@link isMarkdownPath}. */
export const isMarkdownFile = isMarkdownPath;

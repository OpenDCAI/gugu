/** Compare folder paths from the same device, preserving case and the filesystem root. */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalize = (path: string) => {
    const trimmed = path.trim();
    if (trimmed === '/' || trimmed === '~' || /^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed.replace(/\\/g, '/');
    return trimmed.replace(/[\\/]+$/, '');
  };
  return !!a && !!b && normalize(a) === normalize(b);
}

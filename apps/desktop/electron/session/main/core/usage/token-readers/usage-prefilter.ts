/** ASCII structural markers shared by byte-block and line filters. */
export function createUsagePrefilter(alternatives: readonly (readonly string[])[]) {
  const groups = alternatives.map(group => group.map(text => {
    if (!/^[\x00-\x7f]+$/.test(text)) throw new Error('Usage markers must be ASCII');
    return { text, bytes: Buffer.from(text) };
  }));
  return {
    mayCarryUsage: (line: string) => groups.some(group => group.every(marker => line.includes(marker.text))),
    // A complete block can contain markers on different lines: false positives are safe.
    mayCarryUsageBytes: (block: Buffer) => groups.some(group => group.every(marker => block.includes(marker.bytes))),
  };
}

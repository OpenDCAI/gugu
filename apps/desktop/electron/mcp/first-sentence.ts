/**
 * The first sentence of a tool's or a skill's description — what a one-line listing shows: `catalog_list`'s `about`.
 * (An App's own line is its `instructions`, written whole for that line and never cut.)
 * A Latin sentence ends at a `.` followed by whitespace or the end ("v1.2" does not end one); a Chinese one at `。`,
 * which is not followed by a space.
 */
export const firstSentence = (description: string): string =>
  /^[\s\S]*?(?:\.(?=\s|$)|。)/.exec(description)?.[0] ?? description

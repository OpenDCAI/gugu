/**
 * The first sentence of a description — what a one-line listing shows: `catalog_list`'s `about`, and an App's line in
 * `<gugu_apps>` (上下文工程第二批 P3). One rule for both, so a reader sees the same cut in either place.
 * A Latin sentence ends at a `.` followed by whitespace or the end ("v1.2" does not end one); a Chinese one at `。`,
 * which is not followed by a space.
 */
export const firstSentence = (description: string): string =>
  /^[\s\S]*?(?:\.(?=\s|$)|。)/.exec(description)?.[0] ?? description

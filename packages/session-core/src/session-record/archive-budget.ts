/**
 * Optional cache work must stay small on the main thread. These are deliberately
 * more conservative than the disk format's 64 MiB ceiling. Unknown/large values
 * simply lose the cache optimization; native history remains authoritative.
 */
export const TIMELINE_ARCHIVE_MAX_BYTES = 64 * 1024;
export const TIMELINE_ARCHIVE_MAX_ENTRIES = 1024;

/**
 * An upper bound, without encoding or scanning strings (JSON needs at most six
 * bytes per UTF-16 code unit). Count repeated references repeatedly, just as JSON
 * does. Arrays are rejected by length before visiting their elements.
 *
 * Objects here are the timeline's plain JSON records, not arbitrary JS values.
 * Reject custom serializers, accessors and non-JSON instances rather than run
 * code while deciding whether an optional cache is affordable.
 */
export function fitsTimelineArchiveBudget(value: unknown): boolean {
  let bytes = 0;
  let entries = 0;
  const parents = new Set<object>();
  const visit = (one: unknown, depth: number): boolean => {
    if (++entries > TIMELINE_ARCHIVE_MAX_ENTRIES || depth > 32) return false;
    if (typeof one === 'string') bytes += 2 + one.length * 6;
    else if (one === null || typeof one === 'boolean') bytes += 5;
    else if (typeof one === 'number') bytes += 32;
    else if (one === undefined) bytes += 4;
    else if (typeof one === 'object') {
      if (parents.has(one)) return false;
      const array = Array.isArray(one);
      if (array && one.length > TIMELINE_ARCHIVE_MAX_ENTRIES - entries) return false;
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(one))) return false;
      if ('toJSON' in one) return false;
      parents.add(one);
      bytes += 2;
      if (array) {
        for (let i = 0; i < one.length; i++) {
          const property = Object.getOwnPropertyDescriptor(one, i);
          if (property && !('value' in property)) return false;
          bytes++;
          if (!visit(property?.value, depth + 1)) return false;
        }
      } else {
        for (const key in one) {
          if (!Object.hasOwn(one, key)) continue;
          bytes += 4 + key.length * 6;
          if (bytes > TIMELINE_ARCHIVE_MAX_BYTES) return false;
          const property = Object.getOwnPropertyDescriptor(one, key)!;
          if (!('value' in property) || !visit(property.value, depth + 1)) return false;
        }
      }
      parents.delete(one);
    } else return false;
    return bytes <= TIMELINE_ARCHIVE_MAX_BYTES;
  };
  return visit(value, 0);
}

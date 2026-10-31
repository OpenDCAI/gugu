/**
 * What an App needs to be listed in the market, checked in one place. Who reads what:
 * - people: `subtitle` (the line under the name), `store/about*.md` (the product page's 关于), `store/screenshots/`,
 *   `store/whats-new.md` (this version's 新功能);
 * - agents: `contributes.instructions` (the App's line in `<gugu_apps>`), tool descriptions, skills.
 * The manifest schema (manifest.ts) reads the two caps below; the market's verifier imports this exact file from its
 * pinned client commit (as it does app-platforms.ts), so the rules are never copied.
 * No imports: Node 24 strips this module's types and runs it as is.
 */

/** The line under the name: one line in Chinese (~20 characters) and in English (30). */
export const SUBTITLE_MAX_CHARS = 30;
/** An App's whole standing line for agents, placed in full in every session's `<gugu_apps>`. */
export const INSTRUCTIONS_MAX_CHARS = 160;
export const ABOUT_MAX_CHARS = 4000;
export const WHATS_NEW_MAX_CHARS = 4000;
export const SCREENSHOTS_MIN = 1;
export const SCREENSHOTS_MAX = 8;
export const SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const ICON_MAX_BYTES = 32 * 1024;
export const ICON_MAX_PIXELS = 512;
/** The folder of a source directory the listing is read from. Never packed into the App's bundle. */
export const STORE_DIR = 'store';

export interface AppListingInput {
  /** The manifest as JSON (not yet schema-checked: the client's install does that). */
  manifest: unknown;
  /** `store/about.md` under the manifest's `defaultLocale`, each `store/about.<tag>.md` under its tag. */
  about: Readonly<Record<string, string>>;
  /** `store/screenshots/*`, in file-name order. */
  screenshots: readonly { name: string; bytes: Uint8Array }[];
  /** `store/whats-new.md`, or null when it is missing. */
  whatsNew: string | null;
  /** The bytes of `manifest.icon`, or null when the manifest names none. */
  icon: Uint8Array | null;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (bytes: Uint8Array, signature: readonly number[]) => signature.every((byte, index) => bytes[index] === byte);
const chars = (text: string) => [...text].length;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Every reason this version cannot be listed; empty = it can. */
export function appListingProblems(input: AppListingInput): string[] {
  const problems: string[] = [];
  const manifest = (input.manifest && typeof input.manifest === 'object' ? input.manifest : {}) as {
    subtitle?: unknown;
    defaultLocale?: unknown;
    engines?: { gugu?: unknown };
    localized?: Record<string, { subtitle?: unknown }>;
  };
  if (!isText(manifest.subtitle) || chars(manifest.subtitle) > SUBTITLE_MAX_CHARS) {
    problems.push(`subtitle: a listed App needs one, 1–${SUBTITLE_MAX_CHARS} characters`);
  }
  if (!isText(manifest.engines?.gugu)) problems.push('engines.gugu: a listed App names the oldest gugu it runs on (">=x.y.z")');
  if (!isText(manifest.defaultLocale)) problems.push('defaultLocale: a listed App says which language its base fields are in');
  const languages = isText(manifest.defaultLocale) ? [manifest.defaultLocale, ...Object.keys(manifest.localized ?? {})] : [];
  for (const tag of languages) {
    const text = input.about[tag];
    const file = tag === manifest.defaultLocale ? 'store/about.md' : `store/about.${tag}.md`;
    if (!isText(text)) problems.push(`${file}: missing — the product page's 关于 in every language the manifest is written in`);
    else if (chars(text) > ABOUT_MAX_CHARS) problems.push(`${file}: more than ${ABOUT_MAX_CHARS} characters`);
    else if (/!\[[^\]]*\]\(|<img\b/i.test(text)) problems.push(`${file}: text only — screenshots go in store/screenshots/`);
  }
  for (const tag of Object.keys(input.about).filter((tag) => !languages.includes(tag))) {
    problems.push(`store/about.${tag}.md: the manifest is not written in ${tag} (add it to localized, or remove the file)`);
  }
  if (input.screenshots.length < SCREENSHOTS_MIN || input.screenshots.length > SCREENSHOTS_MAX) {
    problems.push(`store/screenshots/: ${SCREENSHOTS_MIN}–${SCREENSHOTS_MAX} images, found ${input.screenshots.length}`);
  }
  for (const shot of input.screenshots) {
    if (!/\.(png|jpe?g)$/i.test(shot.name) || !(startsWith(shot.bytes, PNG) || startsWith(shot.bytes, JPEG))) {
      problems.push(`store/screenshots/${shot.name}: PNG or JPEG only`);
    } else if (shot.bytes.byteLength > SCREENSHOT_MAX_BYTES) {
      problems.push(`store/screenshots/${shot.name}: more than 1 MiB`);
    }
  }
  if (!isText(input.whatsNew)) problems.push('store/whats-new.md: missing — what this version changed (首次发布 for a first one)');
  else if (chars(input.whatsNew) > WHATS_NEW_MAX_CHARS) problems.push(`store/whats-new.md: more than ${WHATS_NEW_MAX_CHARS} characters`);
  if (input.icon) {
    if (input.icon.byteLength > ICON_MAX_BYTES) problems.push('icon: more than 32 KiB');
    if (input.icon.byteLength < 24 || !startsWith(input.icon, PNG)) problems.push('icon: the market draws PNG only');
    else {
      const view = new DataView(input.icon.buffer, input.icon.byteOffset, input.icon.byteLength);
      const [width, height] = [view.getUint32(16), view.getUint32(20)];
      if (width > ICON_MAX_PIXELS || height > ICON_MAX_PIXELS) problems.push(`icon: ${width}×${height} is larger than ${ICON_MAX_PIXELS}px`);
    }
  }
  return problems;
}

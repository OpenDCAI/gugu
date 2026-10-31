/**
 * The URL scheme this build answers to. Refs #6387.
 *
 * One per build channel, because production and Beta live side by side on one machine
 * and the OS hands a scheme to exactly one app: with both claiming `gugu://`, a link an
 * extension made in Beta would open production — or the other way round, depending on
 * which launched last. A link names the build that made it.
 *
 * A source-launched dev app gets its own too, so running one never takes over the
 * links of the installed app on the same machine.
 */
export function guguLinkScheme(input) {
  if (input.devLaunch) return 'gugu-dev';
  const tier = (input.tier ?? 'production').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return tier === 'production' ? 'gugu' : `gugu-${tier}`;
}

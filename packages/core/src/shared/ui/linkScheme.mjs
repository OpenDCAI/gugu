/**
 * What a build tier or release channel adds to every name it must not share with the installed
 * production app: home dirs, tmux labels, link schemes, gugu-server names. Production (the `stable`
 * channel) adds nothing.
 */
export function tierSuffix(name) {
  return name === 'production' || name === 'stable' ? '' : `-${name}`;
}

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
  return `gugu${tierSuffix(tier)}`;
}

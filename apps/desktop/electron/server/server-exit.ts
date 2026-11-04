/** Exit meanings shared by the server and its service managers. */
export const EXIT_RESTART = 75
export const EXIT_CONFIG = 78
export const EXIT_SIGNED_OUT = 79

/** The compatibility run-account command shares main but remains under its old supervisor. */
export function isSingleServerRun(): boolean {
  return process.env.GUGU_SERVER_MODE === '1' && (process.argv[2] === undefined || process.argv[2] === 'run')
}

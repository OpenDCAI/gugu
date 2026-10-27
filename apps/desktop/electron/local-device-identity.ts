/**
 * Which device row is this computer's, announced the moment it becomes known.
 *
 * The shell signs in first and hands the sign-in to this process just after, so a device list read in between cannot
 * tell this computer's own row apart (chat.listDevices refuses to guess, #777). Readers wait for this announcement
 * instead: it fires whenever the answer goes from unknown (or another account's device) to a device id — first sign-in,
 * sign-in after a sign-out, account switch, or a resolution that failed before and succeeds now.
 */
export function announceLocalDeviceIdentity(
  resolve: () => Promise<string | null>,
  announce: (deviceId: string) => void,
): () => Promise<string | null> {
  let last: string | null = null
  return async () => {
    const deviceId = await resolve()
    const changed = deviceId !== null && deviceId !== last
    last = deviceId
    if (changed) announce(deviceId)
    return deviceId
  }
}

import { MAC_PRIVACY, fail, ok, requestHelperPermission, type ActionFamily, type FamilyContext, type Outcome } from '../catalog'
import { NativeCallError } from '../native/mac-helper-client'

function captureFailure(error: unknown): Outcome {
  const message = error instanceof Error ? error.message : String(error)
  return fail(error instanceof NativeCallError && error.code === 'os_permission' ? 'os_permission' : 'execution_failed', message)
}

/** Looking at the screen is a host capability, independent of the Computer Use App and its driver. */
export function createScreenFamily(): ActionFamily {
  const capture = (ctx: FamilyContext, maxEdge: number) => ctx.deps.captureScreen?.({ maxEdge })
  return {
    groups: [{
      id: 'screen',
      platforms: ['darwin', 'win32', 'linux'],
      iconApp: '/System/Applications/Utilities/Screenshot.app',
      ...(process.platform === 'darwin' ? {
        settingsUrl: MAC_PRIVACY('Privacy_ScreenCapture'),
        osPermission: '系统设置 → 隐私与安全性 → 屏幕录制 → 打开咕咕',
      } : {}),
      async probe(ctx) {
        if (!ctx.deps.captureScreen) return fail('unsupported', 'This build of 咕咕 cannot capture the screen')
        if (ctx.deps.platform === 'darwin') {
          // Only the person's Connect action requests access; ordinary capture
          // reads Electron's real status and never uses the CUA permission cache.
          const allowed = await requestHelperPermission(ctx, 'screen', '屏幕录制')
          if (!allowed.ok) return Object.assign(allowed, { restart: true as const })
        }
        try {
          await capture(ctx, 320)
          return ok(null)
        } catch (error) {
          const outcome = captureFailure(error)
          return ctx.deps.platform === 'darwin' && !outcome.ok && outcome.code === 'os_permission'
            ? Object.assign(outcome, { restart: true as const }) : outcome
        }
      },
    }],
    actions: [{
      name: 'screen.get',
      group: 'screen',
      title: '看屏幕',
      titleEn: 'See screen',
      description: 'Capture this computer\'s screen with Electron and return it as a picture (longest edge at most 1568 px), with its actual width, height and number of displays. Uses the primary display when identified; on Linux a portal may supply one system-selected screen. Does not require Computer Use or Accessibility permission.',
      risk: 'medium',
      confirm: 'never',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      unsupportedReason: deps => deps.captureScreen ? null : 'This build of 咕咕 cannot capture the screen',
      async run(_args, ctx) {
        try {
          const shot = await capture(ctx, 1568)
          if (!shot) return fail('unsupported', 'This build of 咕咕 cannot capture the screen')
          return ok({ width: shot.width, height: shot.height, displays: shot.displays,
            pictures: [{ label: 'screen.get screenshot', mimeType: shot.mimeType, data: shot.data }] })
        } catch (error) { return captureFailure(error) }
      },
    }],
  }
}

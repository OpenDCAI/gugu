import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import { useRemoteHostsBridge } from '../../hooks/useRemoteHostsBridge'
import { requestAddServerOnOpen } from '../../lib/addServerIntent'
import { RemoteFolderPicker } from '../RemoteFolderPicker'
import { SshLinkSignIn } from '../SshLinkSignIn'
import { Sheet } from '../ui/Sheet'
import { useDevicesStore } from '@/store/devicesContext'
import { usePhoneAgentDirectory } from '@/mobile/local-agent/usePhoneAgentDirectory'
import { useMobileShell } from '@/hooks/useMobileShell'
import { usePhoneTaskDirectoryRequested } from '@/session/shared/remote-sessions/session-directory'

/**
 * #6264 会话页里的别的机器(按 Zed)在壳这一侧的那几件:名下机器与问那台机器的接口经桥交给会话页;
 * 远程 SSH 的机器连不上时「怎么修」只在这一处说(SshLinkSignIn);创建框选了别的机器时「浏览那台机器上的文件夹」
 * 由这里画 —— 创建框在会话页的 shadow root 里,gugu 的组件进不去。
 * 桌面也放行远端设备:「任何客户端都能指挥任何一台在线的 gugu 机器」(run-target),咕咕 server 登录后就是这样一台。
 */
export function RemoteMachinesHost({ enabled, openSettingsSection }: {
  enabled: boolean
  openSettingsSection: (section: ActiveSection) => void
}) {
  const { t } = useTranslation()
  const { devices, phones = [] } = useDevicesStore()
  const mobile = useMobileShell()
  const phoneTasksOpen = usePhoneTaskDirectoryRequested()
  // Phones publish summaries through their own protocol, never the workspace bridge below.
  // On mobile the existing AgentWatchRoot owns this synchronization instead.
  usePhoneAgentDirectory(enabled && !mobile && phoneTasksOpen ? [...devices, ...phones] : [])
  const [request, setRequest] = useState<{
    deviceId: string
    initialPath: string
    resolve: (path: string | null) => void
  } | null>(null)
  const pickRemoteFolder = useCallback((deviceId: string, initialPath: string) =>
    new Promise<string | null>((resolve) => setRequest({ deviceId, initialPath, resolve })), [])
  // 新建框的机器选择器里「添加一台机器」→ 设置 → 设备,直接进入添加那一步。
  const openSettingsRef = useRef(openSettingsSection)
  openSettingsRef.current = openSettingsSection
  const openAddMachine = useCallback(() => {
    requestAddServerOnOpen()
    openSettingsRef.current('devices')
  }, [])
  useRemoteHostsBridge(enabled, pickRemoteFolder, openAddMachine)
  const settle = (path: string | null) => { request?.resolve(path); setRequest(null) }

  return (
    <>
      {enabled && <SshLinkSignIn />}
      {request && (
        <Sheet
          onClose={() => settle(null)}
          ariaLabel={t('create.composer.project', { ns: 'agents' })}
          desktopWidth="min(640px, calc(100vw - 32px))"
          mobileHeight="80dvh"
          testId="agent-create-project-sheet"
        >
          <div className="p-4">
            <RemoteFolderPicker
              deviceId={request.deviceId}
              initialPath={request.initialPath}
              onCancel={() => settle(null)}
              onSelect={(path) => settle(path)}
            />
          </div>
        </Sheet>
      )}
    </>
  )
}

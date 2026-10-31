import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, UpdateGroupChatSettingsInput } from '@gugu/core/shared/types/chat'
import { chatService } from '../../lib/chat'
import { rendererLogger } from '../../lib/log'

const settingsLog = rendererLogger('chat/group-settings')

type SettingsKey = keyof UpdateGroupChatSettingsInput & keyof GroupChatSettings

function pick(source: GroupChatSettings, keys: readonly SettingsKey[]): Partial<GroupChatSettings> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Partial<GroupChatSettings>
}

/**
 * @@@6418 群设置的读与写。每一项改动**即时落库**(原来 9 项攒到底部「保存」一起写,关抽屉就丢)。
 *
 * - 读:打开抽屉读一次 getGroupChatSettings;失败 fail-loud(#1125),❌ 显示默认值假装读到了。
 * - 写:先把改动乐观地写进本地,再 updateGroupChatSettings。
 *   几次写可能同时在路上(连拨几个开关),所以**每次写只认领自己那几个字段**:
 *   · 成功时只把服务端返回里「这次写的字段」并回本地 —— 晚到的响应不会把别的字段盖回旧值;
 *   · 失败时只把「这次写的字段」回滚到改之前 —— 不会顺带撤掉同时成功的另一项(或刚传好的头像)。
 *   同一字段被连写两次时,只有最后一次发出的那次有资格改它(per-field 序号)。
 */
export function useGroupChatSettings(chatId: string | null, revision?: unknown) {
  const { t } = useTranslation('messaging')
  const [settings, setSettings] = useState<GroupChatSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const settingsRef = useRef<GroupChatSettings | null>(null)
  settingsRef.current = settings
  const latestWrite = useRef(new Map<SettingsKey, number>())
  const writeSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    setSettings(null)
    setError(null)
    latestWrite.current.clear()
    if (!chatId) return
    chatService.getGroupChatSettings(chatId)
      .then((loaded) => { if (!cancelled) setSettings(loaded) })
      .catch((err: unknown) => {
        if (cancelled) return
        settingsLog.error({ error: err, chatId }, 'group settings load failed')
        setError(t('group.settings.loadFailed', { reason: String((err as Error)?.message ?? err) }))
      })
    return () => { cancelled = true }
  }, [chatId, t, revision])

  const update = useCallback(async (input: UpdateGroupChatSettingsInput): Promise<boolean> => {
    const before = settingsRef.current
    if (!chatId || !before) {
      // 设置还没读到(或读失败)时写,只会拿一个不存在的「之前」去对账 —— 明说,❌ 静默丢掉这次操作。
      setError(t('group.settings.notLoaded'))
      return false
    }
    const keys = Object.keys(input) as SettingsKey[]
    const seq = ++writeSeq.current
    for (const key of keys) latestWrite.current.set(key, seq)
    const ownedKeys = () => keys.filter((key) => latestWrite.current.get(key) === seq)
    setError(null)
    setSettings((current) => (current ? { ...current, ...input } as GroupChatSettings : current))
    try {
      const updated = await chatService.updateGroupChatSettings(chatId, input)
      const owned = ownedKeys()
      setSettings((current) => (current ? { ...current, ...pick(updated, owned) } : updated))
      return true
    } catch (err) {
      const owned = ownedKeys()
      setSettings((current) => (current ? { ...current, ...pick(before, owned) } : current))
            settingsLog.error({ error: err, chatId, fields: keys }, 'group settings update failed')
      setError(messageForUser(err))
      return false
    }
  }, [chatId, t])

  const setAvatarUrl = useCallback((avatarUrl: string) => {
    setSettings((current) => (current ? { ...current, avatar_url: avatarUrl } : current))
  }, [])

  return { settings, error, setError, update, setAvatarUrl }
}

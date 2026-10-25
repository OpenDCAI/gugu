import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { openBillingPage } from '../../lib/appLinks'
import { fetchPlatformModelCatalog, setPlatformModelHidden, type PlatformCatalogModel } from '../../lib/agentModelSelection'
import { rendererLogger } from '../../lib/log'
import { Button } from '../ui/Button'
import { SearchField } from '../ui/SearchField'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow, Toggle } from './SettingsPrimitives'

/**
 * 模型 pane(#7056)—— 照 Cursor 的 Settings › Models:列出咕咕提供的全部模型,开关决定**哪些出现在模型下拉里**。
 *
 * owner 2026-10-10 看着 Cursor 定的:下拉里只放点得中、跑得起来的;「升级解锁更多模型」与「自定义下拉里有哪些」
 * 都在这一页。从前把会员模型列进下拉、点它去开通 —— 原话「像是埋雷,让用户稍不留意就点到了他用不了的模型」。
 *
 *  - 用得了的一组:每条一个开关。关掉 = 下拉里不列(跟着账号走,手机、别的电脑一样)。只管显示,
 *    正在跑的会话不受影响,agent 自己起会话也照样能用(与 Cursor 同一语义)。
 *  - 要会员的一组(免费档才有):不给开关 —— 开了也用不了;一处「升级解锁」去网页面板。
 *
 * 存哪一格由 `model-access` 管(`set_model_hidden`),这里 ❌ 自己写 user_settings。
 * #5111 删掉的 BYO「已配置服务」那一块与这里无关,真要做时另立 issue。
 */
const paneLog = rendererLogger('settings/model-pane')

export function ModelSection() {
  const { t } = useTranslation('settings')
  const [models, setModels] = useState<PlatformCatalogModel[] | null>(null)
  const [loadFailed, setLoadFailed] = useState('')
  const [saveFailed, setSaveFailed] = useState('')
  // 列表顶上一格搜索(Cursor 那页同款):按名字或 id 筛,两组一起筛。
  const [query, setQuery] = useState('')

  const load = useCallback(() => {
    let live = true
    setLoadFailed('')
    fetchPlatformModelCatalog()
      .then((next) => { if (live) setModels(next.filter((model) => model.enabled)) })
      .catch((cause: unknown) => {
        paneLog.error({ error: String(cause) }, 'platform model catalog unavailable')
        if (live) setLoadFailed(messageForUser(cause))
      })
    return () => { live = false }
  }, [])
  useEffect(load, [load])

  const toggle = (model: PlatformCatalogModel, shown: boolean) => {
    setSaveFailed('')
    // 先拨过去再存:开关的手感不该等一趟网络。存失败就说一句,并以服务端为准重读一遍 ——
    // ❌ 手动拨回点击那一刻的值:连拨几下时那个值早就旧了;模型刚好下架(404)时重读也让它从列表里消失。
    setModels((current) => current?.map((entry) => (entry.id === model.id ? { ...entry, hidden: !shown } : entry)) ?? current)
    setPlatformModelHidden(model.id, !shown).catch((cause: unknown) => {
      paneLog.error({ modelId: model.id, error: String(cause) }, 'saving model visibility failed')
      setSaveFailed(messageForUser(cause))
      fetchPlatformModelCatalog()
        .then((next) => setModels(next.filter((entry) => entry.enabled)))
        .catch((reloadCause: unknown) => paneLog.error({ error: String(reloadCause) }, 'reloading models after a failed save failed'))
    })
  }

  const needle = query.trim().toLowerCase()
  const matched = (models ?? []).filter((model) =>
    !needle || model.displayName.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))
  const usable = matched.filter((model) => !model.requiresMembership)
  const locked = matched.filter((model) => model.requiresMembership)

  return (
    <SettingsPage data-testid={AUTOMATION_TEST_IDS.settingsModelPane}>
      <SettingsNote>{t('model.description')}</SettingsNote>
      {loadFailed ? (
        <SettingsGroup title={t('model.provided')}>
          <SettingsRow
            description={loadFailed}
            control={<Button variant="secondary" size="sm" onClick={load}>{t('model.retry')}</Button>}
          />
        </SettingsGroup>
      ) : models === null ? (
        <SettingsNote>{t('model.loading')}</SettingsNote>
      ) : (
        <>
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('model.search')}
            clearLabel={t('model.searchClear')}
            onClear={() => setQuery('')}
            data-testid="settings-model-search"
          />
          {needle && usable.length === 0 && locked.length === 0 && (
            <SettingsNote>{t('model.noMatch')}</SettingsNote>
          )}
          {usable.length > 0 && (
            <SettingsGroup
              title={t('model.provided')}
              data-testid="settings-model-usable"
              footer={saveFailed ? <SettingsNote tone="danger">{saveFailed}</SettingsNote> : undefined}
            >
              {usable.map((model) => (
                <SettingsRow
                  key={model.id}
                  data-model-id={model.id}
                  title={model.displayName}
                  control={(
                    <Toggle
                      checked={!model.hidden}
                      onChange={(shown) => toggle(model, shown)}
                      ariaLabel={t('model.toggleAria', { model: model.displayName })}
                    />
                  )}
                />
              ))}
            </SettingsGroup>
          )}
          {locked.length > 0 && (
            <SettingsGroup title={t('model.membersOnly')} data-testid="settings-model-locked">
              {/* 一处去路,❌ 每行一枚按钮:那是同一句话说 N 遍。买会员只在网页面板(GUGU_BILLING_URL 抬头写了为什么)。 */}
              <SettingsRow
                description={t('model.upgradeHint')}
                control={<Button variant="secondary" size="sm" onClick={openBillingPage}>{t('model.upgrade')}</Button>}
              />
              {locked.map((model) => (
                <SettingsRow key={model.id} data-model-id={model.id} title={model.displayName} />
              ))}
            </SettingsGroup>
          )}
        </>
      )}
    </SettingsPage>
  )
}

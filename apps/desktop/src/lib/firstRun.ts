import { readUserSettingsConfig, writeUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { completedFirstRunHarness, firstRunStage, parseOccupation, withOccupation, type FirstRunStage, type FirstRunHarness, type Occupation } from '@gugu/core/shared/firstRun'
import { parseProductTourPosition, type ProductTourPosition } from './productTour'
import { identityDb } from './supabase'
import { readOwnOnboardedAt } from './identityReadAdapter'

// 新账号的第一次打开(product spec,#7348)的读写。规则在 @gugu/core/shared/firstRun。

const settingsClient = identityDb as unknown as SettingsTableClient
const USER_SCOPE = 'user'

export type FirstRunProgress = { stage: FirstRunStage; occupation: Occupation | null; harness: FirstRunHarness[] | null; tour: ProductTourPosition | null }

// 走完是单向的(onboarded_at 只会从空变成有):这台设备读到过一次「走完」(或在这里走完)就按账号记下,以后门口直接放行,
// ❌ 每次再联网核(断网 / 网慢时老用户被挡在门口)。没记过的照旧读,读不到照旧如实说。存不下(隐私模式)= 下次照旧读。
const doneKey = (userId: string) => `gugu.firstRun.done:${userId}`
export function firstRunDoneHere(userId: string): boolean { try { return localStorage.getItem(doneKey(userId)) !== null } catch { return false } }
export function rememberFirstRunDone(userId: string): void { try { localStorage.setItem(doneKey(userId), '1') } catch { /* 见上 */ } }

/** 读不到(网络 / 权限 / 行不对)就 throw —— 门口如实说读不到,❌ 当新账号重走,❌ 当走完放行。 */
export async function readFirstRunProgress(userId: string): Promise<FirstRunProgress> {
  const [onboardedAt, config] = await Promise.all([
    readOwnOnboardedAt(userId),
    readUserSettingsConfig(settingsClient, userId, USER_SCOPE),
  ])
  const occupation = parseOccupation(config)
  return { stage: firstRunStage({ onboardedAt, occupation }), occupation, harness: completedFirstRunHarness(config), tour: onboardedAt ? null : parseProductTourPosition(config) }
}

export async function readOccupation(userId: string): Promise<Occupation | null> {
  return parseOccupation(await readUserSettingsConfig(settingsClient, userId, USER_SCOPE))
}

/** 读-改-写同一行:配置里别的键(建 agent 的默认值)原样留着。 */
export async function writeOccupation(userId: string, occupation: Occupation): Promise<void> {
  const config = await readUserSettingsConfig(settingsClient, userId, USER_SCOPE)
  await writeUserSettingsConfig(settingsClient, userId, USER_SCOPE, withOccupation(config, occupation))
}

export async function writeFirstRunHarness(userId: string, harness: FirstRunHarness[]): Promise<void> {
  const config = await readUserSettingsConfig(settingsClient, userId, USER_SCOPE)
  await writeUserSettingsConfig(settingsClient, userId, USER_SCOPE, { ...config, firstRunHarness: harness })
}

/**
 * 「认识咕咕」那一屏按了任一个钮 = 首次引导走完,记在账号上(换设备不再出现)。
 * 由服务端按本人记(identity.finish_first_run,gugu-supabase #7348):客户端不再多一处直写 identity.users。
 * 返回 null = 没记上(不是本人 / 读不到这一行)→ throw,❌ 当成走完放行。
 */
export async function finishFirstRun(): Promise<string> {
  const { data, error } = await identityDb.rpc('finish_first_run')
  if (error) throw new Error(error.message)
  if (typeof data !== 'string' || !data) throw new Error('finish_first_run returned no timestamp')
  return data
}

// 「开通我的咕咕」:引导走完后主界面接着打开咕咕那一格、直接落在「住在哪」(这一屏已经兼任了介绍)。
// 一次性的交接条,只活在这一次打开里(sessionStorage),❌ 写进账号 —— 下次打开还跳一遍就成了骚扰。
// 两格各由一方取走:主界面取「打开那一格」,开通流程取「从住在哪开始」;各取各的,谁先挂载都不吞掉另一格。
const HANDOFF_OPEN = (userId: string) => `gugu.firstRun.openAssistant:${userId}`
const HANDOFF_STEP = (userId: string) => `gugu.firstRun.assistantStartAtHome:${userId}`

export function requestAssistantSetupHandoff(userId: string): void {
  sessionStorage.setItem(HANDOFF_OPEN(userId), '1')
  sessionStorage.setItem(HANDOFF_STEP(userId), '1')
}

function take(key: string): boolean {
  const asked = sessionStorage.getItem(key) === '1'
  if (asked) sessionStorage.removeItem(key)
  return asked
}

/** 主界面挂载时问一次:要不要直接打开咕咕那一格。 */
export function takeAssistantOpenRequest(userId: string): boolean {
  return take(HANDOFF_OPEN(userId))
}

/** 开通流程挂载时问一次:要不要跳过介绍、从「住在哪」开始。 */
export function takeAssistantStartAtHome(userId: string): boolean {
  return take(HANDOFF_STEP(userId))
}

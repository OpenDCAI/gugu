import { createContext, useContext } from 'react'
import type { AssistantHomePlace } from '@/lib/assistantHome'

/**
 * 它此刻住哪(云上 / 哪台电脑):读它家里东西的那几道门(PhoneMachineGate)按它说话 ——
 * 住电脑 = 「那台没开,读不到」,❌「叫醒」「连不上云」。没认出它 = null(门按云上的说法)。助理 App 在根上给。
 */
export const PhoneHomeContext = createContext<AssistantHomePlace | null>(null)

export function usePhoneHome(): AssistantHomePlace | null {
  return useContext(PhoneHomeContext)
}

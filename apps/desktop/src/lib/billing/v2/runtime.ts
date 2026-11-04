import { dataClient, getCurrentAuthUserId } from '../../supabase'
import { i18n } from '@/i18n'
import { createCreditV2Reader } from './readers'
import { classifyCreditV2Error, createActiveCreditV2Reader, CreditV2StateError } from './active'

export const creditV2 = createCreditV2Reader(dataClient, getCurrentAuthUserId)
export const activeCreditV2 = createActiveCreditV2Reader(creditV2, getCurrentAuthUserId)

export async function creditV2Read<T>(read: () => Promise<T>): Promise<T> {
  try { return await read() }
  catch (error) {
    const classified = classifyCreditV2Error(error)
    if (classified instanceof CreditV2StateError) {
      throw new Error(i18n.t(`credits.v2.${classified.state}`, { ns: 'settings' }), { cause: classified })
    }
    throw classified
  }
}

export const readCreditV2Account = () => creditV2Read(() => activeCreditV2.account())

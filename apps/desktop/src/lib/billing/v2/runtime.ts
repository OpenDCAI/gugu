import { dataClient, getCurrentAuthUserId } from '../../supabase'
import { i18n } from '@/i18n'
import { createCreditV2Reader } from './readers'
import { classifyCreditV2Error, createActiveCreditV2Reader, CreditV2StateError } from './active'

export const creditV2 = createCreditV2Reader(dataClient, getCurrentAuthUserId)
export const activeCreditV2 = createActiveCreditV2Reader(creditV2, getCurrentAuthUserId)

function presentationError(error: unknown): unknown {
  const classified = classifyCreditV2Error(error)
  return classified instanceof CreditV2StateError
    ? new Error(i18n.t(`credits.v2.${classified.state}`, { ns: 'settings' }), { cause: classified })
    : classified
}

export async function creditV2Read<T>(read: () => Promise<T>): Promise<T> {
  try { return await read() }
  catch (error) { throw presentationError(error) }
}

export const readCreditV2Account = () => creditV2Read(async () => {
  const account = await activeCreditV2.account()
  return { ...account,
    balanceError: account.balanceError === null ? null : presentationError(account.balanceError),
    windowsError: account.windowsError === null ? null : presentationError(account.windowsError),
  }
})

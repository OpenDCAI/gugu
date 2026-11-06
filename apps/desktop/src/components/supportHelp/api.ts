import { identityDb } from '@/lib/supabase'
import { readHelpInfo, readHelpJoin, type SupportHelpInfo } from './contract'

export async function fetchSupportHelp(signal?: AbortSignal) {
  const request = identityDb.rpc('official_help_info')
  const { data, error } = await (signal ? request.abortSignal(signal) : request)
  // Never surface/log backend error text: it may contain private configuration.
  if (error) throw new Error('Support help could not be loaded')
  return readHelpInfo(data)
}
export async function joinSupportHelp(info: SupportHelpInfo) {
  if (!info.group.id) throw new Error('Sign in before joining support help')
  const { data, error } = await identityDb.rpc('official_help_join', {
    p_expected_version: info.version, p_expected_group_id: info.group.id,
  })
  if (error) throw new Error('Support help could not be joined')
  return readHelpJoin(data)
}

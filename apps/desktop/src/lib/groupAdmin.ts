import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
import { chatDb, getCurrentAuthUserId } from './supabase'

export async function currentGroupAdmin() {
  return createGroupAdmin(chatDb, await getCurrentAuthUserId())
}

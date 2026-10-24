import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { useChatSearch } from './useChatSearch'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { SearchField } from '../ui/SearchField'
import { Button } from '../ui/Button'

export function ChatSearchControls({ search }: { search: ReturnType<typeof useChatSearch> }) {
  const { t } = useTranslation('messaging')
  const [composition, setComposition] = useState<string | null>(null)
  const close = () => { search.setSearchMode(false); search.setSearchQuery('') }
  return <>
    <SearchField ref={search.searchInputRef} className="flex-1" data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchInput}
      value={composition ?? search.searchQuery}
      onCompositionStart={(event) => setComposition(event.currentTarget.value)}
      onCompositionEnd={(event) => { setComposition(null); search.setSearchQuery(event.currentTarget.value) }}
      onChange={(event) => { if (composition === null) search.setSearchQuery(event.target.value); else setComposition(event.target.value) }}
      onKeyDown={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && composition === null) close() }} placeholder={t('chatArea.searchMessages')} />
    <Button variant="ghost" size="sm" className="shrink-0" data-testid={AUTOMATION_TEST_IDS.chatHeaderSearchCancelButton}
      onClick={close}>{t('common.cancel')}</Button>
  </>
}

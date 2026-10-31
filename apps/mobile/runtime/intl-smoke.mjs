import assert from 'node:assert/strict'

/** Run with the packaged Android Node, not the WebView's independent Intl implementation. */
export function checkPhoneIntl() {
  return [
    { locale: 'en-US', weekday: 'Thursday', ordered: ['ä', 'z'], text: 'hello world', words: ['hello', 'world'] },
    { locale: 'zh-CN', weekday: '星期四', ordered: ['李', '张'], text: '你好世界', words: ['你好', '世界'] },
    { locale: 'ja-JP', weekday: '木曜日', ordered: ['は', 'ば', 'ぱ'], text: '私は猫です', words: ['私', 'は', '猫', 'です'] },
  ].map(({ locale, weekday, ordered, text, words }) => {
    for (const type of [Intl.DateTimeFormat, Intl.NumberFormat, Intl.Collator, Intl.Segmenter]) {
      assert.deepEqual(type.supportedLocalesOf([locale], { localeMatcher: 'lookup' }), [locale], `${type.name}: ${locale}`)
    }
    const date = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date('2020-01-02T12:00:00Z'))
    assert.equal(date, weekday, `${locale}: localized date`)
    const number = new Intl.NumberFormat(locale).format(12345.6)
    assert.equal(number, '12,345.6', `${locale}: decimal/grouping data`)
    const collator = new Intl.Collator(locale)
    assert.equal(collator.resolvedOptions().locale.split('-')[0], locale.split('-')[0], `${locale}: collation fallback`)
    assert.deepEqual([...ordered].reverse().sort(collator.compare), ordered, `${locale}: collation data`)
    const segments = [...new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)].filter((part) => part.isWordLike).map((part) => part.segment)
    assert.deepEqual(segments, words, `${locale}: word dictionary`)
    const graphemes = [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment('👨‍👩‍👧‍👦a')].map((part) => part.segment)
    assert.deepEqual(graphemes, ['👨‍👩‍👧‍👦', 'a'], `${locale}: Unicode grapheme data`)
    return { locale, date, number, ordered, segments, graphemes }
  })
}

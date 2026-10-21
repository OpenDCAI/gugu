// @@@workspace-upload-kind — 一个文件进工作区时,是「活的文本文件」(document:和 files.create 建出来的同一种东西,
// App 能打开来一起改,agent 能 edit(old, new))还是「一包字节」(file)。
// 摩擦单 F19(L7-g,S11):agent 在 /tmp 生成 36 KB 的看板 JSON 传进群,落成 file,工具一声不吭;A 点开,App 报
// 「… is not a document that can be opened for editing」。上传一个 .json 和新建一个 .json 是同一种东西(原则 4)。
// 所以只有这一个判据:files.upload(app-files-core)问它 —— 人在群文件夹里上传,群文件夹 App 的工具替 agent 放文件,
// 都走这一个;app_install 的数据文件也问它。

import { extensionOf, normalizeMimeType } from './imageMime.mjs'

/** 文件服务里一份打开的文本文件的上限(与 files.create、JSON 文件的 edit 同一个数)。 */
export const WORKSPACE_TEXT_MAX_BYTES = 1024 * 1024

const TEXT_TYPE_BY_SUFFIX = new Map([
  ['json', 'application/json'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['csv', 'text/csv'],
  ['txt', 'text/plain'],
  // G4 An HTML page (a report, a deck) is text like markdown: people and agents change it together, Apps open it.
  ['html', 'text/html'],
  ['htm', 'text/html'],
])

/**
 * Whether JSON text is what a JSON file holds — an object at the top: `null` when it is, else why not (`invalid`, with
 * the parser's message, or `not-object`). The one rule for an upload, a new file's content and its
 * default type.
 *
 * @param {string} text
 * @returns {null | { problem: 'invalid', message: string } | { problem: 'not-object' }}
 */
export function jsonObjectProblem(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { problem: 'invalid', message: err instanceof Error ? err.message : String(err) }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? null : { problem: 'not-object' }
}

/**
 * A text kind — the suffix (.json .md .csv .txt .html) or the type (text/*, application/json) says so — that is valid UTF-8
 * within {@link WORKSPACE_TEXT_MAX_BYTES} (and, for JSON, an object at the top, which is what an open file holds) is a
 * document; anything else is a file. A text kind that stays a file says why, so the caller can say it: never silently.
 *
 * @param {string} fileName
 * @param {string | null | undefined} mimeType
 * @param {Uint8Array} bytes
 * @returns {{ kind: 'document', contentType: string, text: string } | { kind: 'file', why: string }}
 */
export function workspaceUploadKind(fileName, mimeType, bytes) {
  const declared = normalizeMimeType(mimeType)
  const bySuffix = TEXT_TYPE_BY_SUFFIX.get(extensionOf(fileName))
  const contentType = bySuffix ?? (declared === 'application/json' || declared.startsWith('text/') ? declared : null)
  if (!contentType) return { kind: 'file', why: 'not a text file (.json, .md, .csv, .txt or a text type)' }
  if (bytes.byteLength > WORKSPACE_TEXT_MAX_BYTES) {
    return { kind: 'file', why: `over the ${WORKSPACE_TEXT_MAX_BYTES / 1024 / 1024} MiB of a live text file` }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { kind: 'file', why: 'not valid UTF-8 text' }
  }
  const problem = contentType === 'application/json' ? jsonObjectProblem(text) : null
  if (problem?.problem === 'invalid') return { kind: 'file', why: 'not valid JSON' }
  if (problem) return { kind: 'file', why: 'a JSON file lives as an object at the top ({...}); this one is not' }
  return { kind: 'document', contentType, text }
}

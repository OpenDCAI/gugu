import { readFileSync, appendFileSync } from 'node:fs'

const eventPath = process.env.GITHUB_EVENT_PATH
const envPath = process.env.GITHUB_ENV
if (!eventPath || !envPath) throw new Error('GITHUB_EVENT_PATH and GITHUB_ENV are required')

const event = JSON.parse(readFileSync(eventPath, 'utf8'))
const body = (event.pull_request?.body ?? '').replace(/<!--[\s\S]*?-->/g, '')
const match = body.match(/^##+\s*(?:怎么测|test notes?)\s*\n([\s\S]*?)(?=^##+\s|\s*$)/im)
const notes = (match?.[1] ?? '').trim().slice(0, 4000)
const delimiter = `GUGU_TEST_NOTES_${process.pid}`
appendFileSync(envPath, `GUGU_TEST_NOTES<<${delimiter}\n${notes}\n${delimiter}\n`)
process.stdout.write(`[pr-test-notes] ${notes ? `loaded ${notes.length} chars` : 'no notes provided'}\n`)

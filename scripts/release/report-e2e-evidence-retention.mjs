#!/usr/bin/env node
// @@@evidence-retention-reconcile (#4214) — 上传证据那一步挂着 `continue-on-error: true`（刻意的：
// 外部存储故障不该伪造门禁结果）。副作用是它的 step **conclusion** 恒为 `success`，真值只留在
// **outcome** 里，失败只以一条 annotation 出现 —— 两条车道各自据此读出了「artifact 能用」这个
// 正好相反的结论。这个脚本把两个读数并排写进 step summary：
//   · 上传步的 `outcome`（未被 continue-on-error 洗过的本地真值）
//   · 本 run 自己的 artifacts 列表（`total_count` + 按名字匹配 —— 独立于上传步的确认）
// 让「本次 e2e 证据没留下」成为一句明写的话，而不是一条容易被当成无害注记的 annotation。
//
// ❌ 不要靠删 `continue-on-error` 来「让它可见」：那会让外部存储故障直接判红整条门禁。
// ⇒ 因此本脚本**恒 exit 0**。它是读数报告，不是闸；判红就等于绕过上面那个取舍。
//   读不到 API 时不编一个听起来顺的结论，报 UNVERIFIED（未判定）。

const repository = process.env.GITHUB_REPOSITORY || ''
const runId = process.env.GITHUB_RUN_ID || ''
const token = process.env.GITHUB_TOKEN || ''
const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const artifactName = process.env.GUGU_EVIDENCE_ARTIFACT_NAME || ''
const uploadOutcome = process.env.GUGU_EVIDENCE_UPLOAD_OUTCOME || ''
const label = process.env.GUGU_EVIDENCE_LABEL || artifactName || 'e2e evidence'

async function readRunArtifacts() {
  if (!repository) return { ok: false, reason: 'GITHUB_REPOSITORY is not set' }
  if (!runId) return { ok: false, reason: 'GITHUB_RUN_ID is not set' }
  if (!token) return { ok: false, reason: 'GITHUB_TOKEN is not set (needs `actions: read`)' }
  const url = `${apiBase}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!response.ok) {
    return { ok: false, reason: `GET ${url} -> HTTP ${response.status} ${response.statusText}` }
  }
  const body = await response.json()
  return { ok: true, total: body.total_count ?? 0, artifacts: Array.isArray(body.artifacts) ? body.artifacts : [] }
}

// 判据：先信独立读数（run 自己的 artifacts），读不到才退回上传步的 outcome。
// `outcome === 'success'` 单独**不足以**判 RETAINED —— 那正是本票要修的那种被洗过的读数。
function decide(reading) {
  if (reading.ok) {
    const match = reading.artifacts.find((artifact) => artifact?.name === artifactName)
    if (match && match.expired !== true && Number(match.size_in_bytes ?? 0) > 0) {
      return { verdict: 'RETAINED', match }
    }
    return { verdict: 'MISSING', match: match ?? null }
  }
  if (uploadOutcome === 'failure') return { verdict: 'MISSING', match: null }
  return { verdict: 'UNVERIFIED', match: null }
}

function renderSummary({ verdict, match, reading }) {
  const rows = [
    ['upload step `outcome`（未被 continue-on-error 洗过）', uploadOutcome ? `\`${uploadOutcome}\`` : '_unset_'],
    ['本 run 的 artifacts `total_count`', reading.ok ? `\`${reading.total}\`` : `_未读到：${reading.reason}_`],
    ['期望的 artifact 名', `\`${artifactName || '(unset)'}\``],
    ['按名字匹配到', match ? `是（${match.size_in_bytes} bytes）` : '否'],
  ]
  const verdictLine = {
    RETAINED: `**本次 e2e 证据已留存**。\`playwright-report/\` 与 \`test-results/\`（含 \`error-context.md\` 的 page snapshot、trace）可从本 run 的 Artifacts 下载。`,
    MISSING: [
      `**本次 e2e 证据未留存** —— \`playwright-report/\`、\`test-results/**/error-context.md\`、trace 这次都没有落到 GitHub。`,
      `排查一条 e2e 红时不要按 \`CLAUDE.md\` 那条「先看 page snapshot」的路径去找：**它是空的**，只能重跑或本地复现。`,
      `最常见原因是账号级 artifact storage 配额已满（\`Failed to CreateArtifact: Artifact storage quota has been hit\`，见 #4214）。`,
      `门禁**不因此判红**：外部存储故障不该伪造门禁结果，本地证据契约（\`playwright-report/\` + \`test-results/\` 存在）已在上一步单独判过。`,
    ].join('\n'),
    UNVERIFIED: [
      `**本次 e2e 证据是否留存：未判定**。上传步的 outcome 不是 \`failure\`，但独立读数（本 run 的 artifacts 列表）没读到，`,
      `所以「已留存」这句话现在没有证据支撑 —— 不补一个听起来顺的结论。`,
      `读不到的原因：${reading.ok ? 'n/a' : reading.reason}`,
    ].join('\n'),
  }[verdict]

  return [
    `### ${label} — e2e 证据留存核对`,
    '',
    '| 读数 | 值 |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    '',
    `RETENTION: ${verdict}`,
    '',
    verdictLine,
    '',
  ].join('\n')
}

async function main() {
  let reading
  try {
    reading = await readRunArtifacts()
  } catch (error) {
    reading = { ok: false, reason: `${error?.message ?? error}` }
  }
  const { verdict, match } = decide(reading)
  const summary = renderSummary({ verdict, match, reading })

  process.stdout.write(`${summary}\n`)
  if (verdict === 'MISSING') {
    process.stdout.write(`::warning title=e2e evidence not retained::${label}: RETENTION MISSING — 本次 run 没有留下 playwright 报告/trace/error-context（见 #4214）\n`)
  } else if (verdict === 'UNVERIFIED') {
    process.stdout.write(`::warning title=e2e evidence retention unverified::${label}: RETENTION UNVERIFIED — ${reading.ok ? '' : reading.reason}\n`)
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(summaryPath, summary)
  }
}

// 恒 exit 0：本步是读数报告，不是闸。见文件头注释。
try {
  await main()
} catch (error) {
  process.stdout.write(`RETENTION: UNVERIFIED\n`)
  process.stdout.write(`::warning title=e2e evidence retention unverified::reconcile step itself failed: ${error?.stack ?? error}\n`)
}
process.exit(0)

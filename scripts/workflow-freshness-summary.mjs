import fs from 'node:fs/promises'
import path from 'node:path'

const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN
const workflowFile = process.env.WORKFLOW_FILE
const scopeHours = 24
const expectedIntervalMinutes = 30
const staleAfterMinutes = 90
const recoveryEnabled = process.env.ENABLE_SCHEDULED_RECOVERY === 'true'
const recoveryRef = process.env.RECOVERY_REF || 'main'

if (!repository || !token || !workflowFile) throw new Error('缺少 GitHub 运行环境或工作流文件名')

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'WorkflowFreshnessMonitor/2.0',
}
const response = await fetch(
  `https://api.github.com/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=100`,
  { headers },
)
if (!response.ok) throw new Error(`GitHub API ${response.status}`)

const now = Date.now()
const cutoff = now - scopeHours * 60 * 60 * 1000
const workflowRuns = (await response.json()).workflow_runs || []
const recentRuns = workflowRuns.filter((run) => new Date(run.created_at).getTime() >= cutoff)
const scheduledRuns = recentRuns.filter((run) => run.event === 'schedule')
const successes = recentRuns
  .filter((run) => run.conclusion === 'success' && run.updated_at)
  .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))
const scheduledSuccesses = scheduledRuns.filter((run) => run.conclusion === 'success' && run.updated_at)
const latestScheduledSuccess = scheduledSuccesses[0] || null
const latestSuccessfulRun = successes[0] || null
const minutesSince = (run) => run ? Math.floor((now - new Date(run.updated_at).getTime()) / 60000) : null
const minutesSinceLatestScheduledSuccess = minutesSince(latestScheduledSuccess)
const minutesSinceLatestSuccess = minutesSince(latestSuccessfulRun)
const statusFor = (minutes) => minutes === null ? 'unknown' : minutes > staleAfterMinutes ? 'stale' : 'healthy'
const collectionFreshnessStatus = statusFor(minutesSinceLatestSuccess)
const schedulerFreshnessStatus = statusFor(minutesSinceLatestScheduledSuccess)
const expectedScheduledRuns = Math.floor((scopeHours * 60) / expectedIntervalMinutes)
const schedulerDeliveryRate = Number((scheduledSuccesses.length / expectedScheduledRuns).toFixed(3))
const activeRuns = recentRuns.filter((run) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status))
let recovery = { enabled: recoveryEnabled, attempted: false, dispatched: false, reason: null }

// GitHub schedule 不是 SLA。仅在长期没有任何成功运行且无活跃任务时补发一次。
if (recoveryEnabled && collectionFreshnessStatus !== 'healthy' && activeRuns.length === 0) {
  recovery.attempted = true
  const dispatchResponse = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ref: recoveryRef }) },
  )
  if (!dispatchResponse.ok) throw new Error(`GitHub recovery dispatch API ${dispatchResponse.status}`)
  recovery = { ...recovery, dispatched: true, reason: '超过新鲜度阈值且没有运行中的采集任务，已补发一次。' }
} else if (!recoveryEnabled) {
  recovery.reason = '未启用补发；只报告状态。'
} else if (collectionFreshnessStatus === 'healthy') {
  recovery.reason = '最近已有成功采集，不补发。'
} else {
  recovery.reason = '已有运行中的采集任务，不补发。'
}

const summary = {
  schemaVersion: 2,
  generatedAt: new Date(now).toISOString(),
  timezone: 'Asia/Taipei',
  workflowFile,
  scopeHours,
  expectedIntervalMinutes,
  expectedScheduledRuns,
  staleAfterMinutes,
  collectionFreshnessStatus,
  schedulerFreshnessStatus,
  minutesSinceLatestSuccess,
  minutesSinceLatestScheduledSuccess,
  schedulerDeliveryRate,
  recentRuns: {
    total: recentRuns.length,
    scheduled: scheduledRuns.length,
    scheduledSuccessful: scheduledSuccesses.length,
    scheduledFailed: scheduledRuns.filter((run) => run.conclusion === 'failure').length,
    anySuccessful: successes.length,
    active: activeRuns.length,
    estimatedMissedScheduledRuns: Math.max(0, expectedScheduledRuns - scheduledSuccesses.length),
  },
  latestScheduledSuccess: latestScheduledSuccess && {
    createdAt: latestScheduledSuccess.created_at,
    updatedAt: latestScheduledSuccess.updated_at,
    conclusion: latestScheduledSuccess.conclusion,
  },
  latestSuccessfulRun: latestSuccessfulRun && {
    event: latestSuccessfulRun.event,
    createdAt: latestSuccessfulRun.created_at,
    updatedAt: latestSuccessfulRun.updated_at,
    conclusion: latestSuccessfulRun.conclusion,
  },
  recovery,
  warning: collectionFreshnessStatus === 'healthy'
    ? (schedulerFreshnessStatus === 'healthy' ? null : '采集仍新鲜，但 GitHub 定时交付不足；这不是严格半小时 SLA。')
    : `已超过 ${staleAfterMinutes} 分钟没有成功运行；${recovery.reason}`,
  securityNote: '仅汇总 GitHub Actions 运行元数据；不读取或输出商品内容、页面正文、密钥或私人业务数据。',
}

const output = path.resolve('临时文件', 'workflow-health', 'workflow-freshness-summary.json')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary))

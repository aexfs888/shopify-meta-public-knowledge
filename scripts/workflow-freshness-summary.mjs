import fs from 'node:fs/promises'
import path from 'node:path'

const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN
const workflowFile = process.env.WORKFLOW_FILE
const scopeHours = 24
const staleAfterMinutes = 90

if (!repository || !token || !workflowFile) {
  throw new Error('缺少 GitHub 只读运行环境或工作流文件名')
}

const response = await fetch(
  `https://api.github.com/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=100`,
  {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WorkflowFreshnessMonitor/1.0',
    },
  },
)

if (!response.ok) throw new Error(`GitHub API ${response.status}`)

const now = Date.now()
const cutoff = now - scopeHours * 60 * 60 * 1000
const workflowRuns = (await response.json()).workflow_runs || []
const recentRuns = workflowRuns.filter((run) => new Date(run.created_at).getTime() >= cutoff)
const scheduledRuns = recentRuns.filter((run) => run.event === 'schedule')
const scheduledSuccesses = scheduledRuns
  .filter((run) => run.conclusion === 'success' && run.updated_at)
  .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))
const latestScheduledSuccess = scheduledSuccesses[0] || null
const minutesSinceLatestScheduledSuccess = latestScheduledSuccess
  ? Math.floor((now - new Date(latestScheduledSuccess.updated_at).getTime()) / 60000)
  : null
const freshnessStatus = minutesSinceLatestScheduledSuccess === null
  ? 'unknown'
  : minutesSinceLatestScheduledSuccess > staleAfterMinutes
    ? 'stale'
    : 'healthy'

const summary = {
  schemaVersion: 1,
  generatedAt: new Date(now).toISOString(),
  timezone: 'Asia/Taipei',
  workflowFile,
  scopeHours,
  expectedIntervalMinutes: 30,
  staleAfterMinutes,
  freshnessStatus,
  minutesSinceLatestScheduledSuccess,
  recentRuns: {
    total: recentRuns.length,
    scheduled: scheduledRuns.length,
    scheduledSuccessful: scheduledSuccesses.length,
    scheduledFailed: scheduledRuns.filter((run) => run.conclusion === 'failure').length,
  },
  latestScheduledSuccess: latestScheduledSuccess && {
    id: latestScheduledSuccess.id,
    createdAt: latestScheduledSuccess.created_at,
    updatedAt: latestScheduledSuccess.updated_at,
    conclusion: latestScheduledSuccess.conclusion,
  },
  warning: freshnessStatus === 'healthy'
    ? null
    : `已超过 ${staleAfterMinutes} 分钟没有成功的定时运行；此摘要只告警，不会触发采集。`,
  securityNote: '仅汇总 GitHub Actions 运行元数据，不读取或输出公开正文、商品内容、密钥或私人业务数据。',
}

const output = path.resolve('临时文件', 'workflow-health', 'workflow-freshness-summary.json')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary))

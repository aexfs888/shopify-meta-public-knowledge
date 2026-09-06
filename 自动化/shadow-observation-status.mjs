import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = 'official-knowledge'
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDirectory = path.join(projectRoot, '临时文件', 'automation')
const stateFile = path.join(stateDirectory, 'collector-state.json')
const historyFile = path.join(stateDirectory, 'run-history.ndjson')
const observationHours = 48
const requiredQualifiedRuns = observationHours * 2

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function readHistory() {
  try {
    const text = await fs.readFile(historyFile, 'utf8')
    return text.split(/\r?\n/).flatMap((line) => {
      if (!line) return []
      try {
        const item = JSON.parse(line)
        return item?.schemaVersion === 1 && item?.project === project ? [item] : []
      } catch { return [] }
    })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

const state = await readJson(stateFile, null)
const history = await readHistory()
const qualified = history.filter((item) => item.mode === 'shadow' && item.state === 'shadow_completed')
const timestamps = qualified.map((item) => Date.parse(item.finishedAt ?? item.startedAt ?? '')).filter(Number.isFinite).sort((a, b) => a - b)
const firstQualifiedAt = timestamps.length ? new Date(timestamps[0]).toISOString() : null
const elapsedHours = timestamps.length ? (Date.now() - timestamps[0]) / 3_600_000 : 0
const unexpectedStates = history.filter((item) => !['shadow_completed', 'skipped_not_due', 'skipped_locked'].includes(item.state))
const currentHealthy = state?.mode === 'shadow' && state?.state === 'shadow_completed' && state?.privateDataAccessed === false && state?.networkCollectionStarted === false
const result = {
  schemaVersion: 1,
  project,
  mode: 'shadow_observation_status',
  checkedAt: new Date().toISOString(),
  observation: { requiredHours: observationHours, elapsedHours: Number(elapsedHours.toFixed(2)), firstQualifiedAt, requiredQualifiedRuns, qualifiedRuns: qualified.length, unexpectedStateCount: unexpectedStates.length },
  currentState: state ? { state: state.state ?? null, mode: state.mode ?? null, privateDataAccessed: state.privateDataAccessed ?? null, networkCollectionStarted: state.networkCollectionStarted ?? null, nextEligibleAt: state.nextEligibleAt ?? null } : null,
  checks: { durationReached: elapsedHours >= observationHours, qualifiedRunCountReached: qualified.length >= requiredQualifiedRuns, noUnexpectedStates: unexpectedStates.length === 0, currentHealthy },
  readyForActiveImplementation: false,
  note: '只读取本机影子状态和历史；不发起采集、不读取真实账户或经营数据。即使观察验收通过，真实刷新仍需隐私闸门、回归测试、恢复点和单独人工审批。',
}
result.observationComplete = Object.values(result.checks).every(Boolean)
console.log(JSON.stringify(result))
process.exitCode = result.observationComplete ? 0 : 2

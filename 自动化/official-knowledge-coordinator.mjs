import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDirectory = path.join(projectRoot, '临时文件', 'automation')
const stateFile = path.join(stateDirectory, 'collector-state.json')
const lockFile = path.join(stateDirectory, 'collector.lock')
const historyFile = path.join(stateDirectory, 'run-history.ndjson')
const mode = process.env.OFFICIAL_KNOWLEDGE_AUTOMATION_MODE || 'shadow'
const now = new Date()
const runId = `knowledge-${now.toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`
const intervalMinutes = 30

if (!['shadow', 'active'].includes(mode)) throw new Error('OFFICIAL_KNOWLEDGE_AUTOMATION_MODE 只能是 shadow 或 active')

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, file)
}

async function appendHistory(value) {
  await fs.appendFile(historyFile, `${JSON.stringify(value)}\n`, 'utf8')
}

async function sha256(file) {
  const crypto = await import('node:crypto')
  const bytes = await fs.readFile(file)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function acquireLock() {
  try {
    const handle = await fs.open(lockFile, 'wx')
    await handle.writeFile(JSON.stringify({ runId, pid: process.pid, startedAt: now.toISOString(), mode }))
    return handle
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return { existing: await readJson(lockFile, { state: 'unknown' }) }
  }
}

async function validatePublishedManifest() {
  const manifestPath = path.join(projectRoot, 'published', 'manifest.json')
  const manifest = await readJson(manifestPath, null)
  if (!manifest) return { ok: false, reason: '未找到已发布 Manifest' }
  const archive = manifest.archive?.file ? path.join(projectRoot, 'published', manifest.archive.file) : null
  if (!archive || !manifest.archive?.sha256) return { ok: false, reason: 'Manifest 缺少归档哈希' }
  try {
    const actual = await sha256(archive)
    return { ok: actual === manifest.archive.sha256, usableSourceCount: manifest.usable_source_count ?? null, sourceFloor: manifest.source_floor ?? null, reason: actual === manifest.archive.sha256 ? null : '归档 SHA-256 不匹配' }
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
}

async function main() {
  await fs.mkdir(stateDirectory, { recursive: true })
  const previous = await readJson(stateFile, null)
  const lock = await acquireLock()
  if ('existing' in lock) {
    const result = { schemaVersion: 1, project: 'official-knowledge', mode, runId, state: 'skipped_locked', startedAt: now.toISOString(), lock: lock.existing }
    await appendHistory(result)
    console.log(JSON.stringify(result))
    return
  }

  const startedAt = Date.now()
  try {
    const packageValidation = await validatePublishedManifest()
    const preflightOk = packageValidation.ok
    const result = {
      schemaVersion: 1,
      project: 'official-knowledge',
      mode,
      runId,
      state: preflightOk ? (mode === 'shadow' ? 'shadow_completed' : 'blocked_active_not_implemented') : 'degraded',
      startedAt: now.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      intervalMinutes,
      previousState: previous?.state ?? null,
      preflight: { publishedPackage: packageValidation },
      nextEligibleAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
      privateDataAccessed: false,
      networkCollectionStarted: false,
      note: mode === 'shadow'
        ? '影子模式只验证最后合格公开知识包；不联网刷新、不发布、不读取真实账户或经营数据。'
        : '主动模式尚未启用，需先完成影子模式观察和规则分层验证。',
    }
    await atomicJson(stateFile, result)
    await appendHistory(result)
    console.log(JSON.stringify(result))
    process.exitCode = preflightOk ? 0 : 2
  } finally {
    await lock.close()
    await fs.rm(lockFile, { force: true })
  }
}

await main()

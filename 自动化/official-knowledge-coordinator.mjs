import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateDirectory = path.join(projectRoot, '临时文件', 'automation')
const stateFile = path.join(stateDirectory, 'collector-state.json')
const lockFile = path.join(stateDirectory, 'collector.lock')
const historyFile = path.join(stateDirectory, 'run-history.ndjson')
const mode = process.env.OFFICIAL_KNOWLEDGE_AUTOMATION_MODE || 'shadow'
const publicRefreshApproved = process.env.OFFICIAL_KNOWLEDGE_PUBLIC_REFRESH_APPROVED === '1'
const publicRefreshTimeoutMs = 55 * 60_000
const publicRefreshProgressFile = path.join(stateDirectory, 'public-refresh-progress.log')
const now = new Date()
const runId = `knowledge-${now.toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`
const intervalMinutes = 30

if (!['shadow', 'public', 'active'].includes(mode)) throw new Error('OFFICIAL_KNOWLEDGE_AUTOMATION_MODE 只能是 shadow、public 或 active')

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

const maxHistoryEntries = 336

async function appendHistory(value) {
  let existing = ''
  try {
    existing = await fs.readFile(historyFile, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const entries = existing.split(/\r?\n/).filter(Boolean)
  const retained = [...entries.slice(-(maxHistoryEntries - 1)), JSON.stringify(value)]
  const temporary = `${historyFile}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${retained.join('\n')}\n`, 'utf8')
  await fs.rename(temporary, historyFile)
}

async function sha256(file) {
  const crypto = await import('node:crypto')
  const bytes = await fs.readFile(file)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function inspectExistingLock() {
  let stat
  try {
    stat = await fs.stat(lockFile)
  } catch {
    return { state: 'unreadable' }
  }

  let metadata = null
  let metadataReadable = true
  try {
    metadata = await readJson(lockFile, null)
  } catch {
    metadataReadable = false
  }
  const startedAt = Date.parse(metadata?.startedAt ?? '')
  const pid = Number.isInteger(metadata?.pid) ? metadata.pid : null
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs)
  const ageMinutes = Math.floor(ageMs / 60_000)
  const pidAlive = processIsAlive(pid)
  const timedOut = ageMs > publicRefreshTimeoutMs + 5 * 60_000
  return {
    state: metadataReadable && Number.isFinite(startedAt) ? 'valid_metadata' : 'malformed_metadata',
    ageMinutes,
    startedAt: Number.isFinite(startedAt) ? metadata.startedAt : null,
    pid,
    pidAlive,
    timedOut,
    stale: !pidAlive || timedOut,
    mode: ['shadow', 'public', 'active'].includes(metadata?.mode) ? metadata.mode : null,
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx')
      await handle.writeFile(JSON.stringify({ runId, pid: process.pid, startedAt: now.toISOString(), mode }))
      return handle
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await inspectExistingLock()
      if (!existing.stale || attempt > 0) return { existing }
      // The former owner is gone or exceeded its coordinator timeout. Remove only this
      // stale local lock, then retry exclusive creation; no source limits are changed.
      await fs.rm(lockFile, { force: true })
    }
  }
  return { existing: await inspectExistingLock() }
}

async function runPublicRefresh() {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd run update']
    : ['run', 'update']
  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, env: { ...process.env, OFFICIAL_KNOWLEDGE_AUTOMATION_MODE: 'public' } })
    const writeProgress = (chunk) => fs.appendFile(publicRefreshProgressFile, String(chunk), 'utf8').catch(() => {})
    const timer = setTimeout(() => { timedOut = true; child.kill() }, publicRefreshTimeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk); writeProgress(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk); writeProgress(chunk) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, timedOut, outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr) }) })
  })
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
  if (mode === 'active') {
    const result = {
      schemaVersion: 1,
      project: 'official-knowledge',
      mode,
      runId,
      state: 'blocked_private_active_not_implemented',
      startedAt: now.toISOString(),
      privateDataAccessed: false,
      networkCollectionStarted: false,
      note: '私密主动模式尚未启用；不会读取真实账户、订单、客户或经营数据。',
    }
    console.log(JSON.stringify(result))
    process.exitCode = 2
    return
  }

  await fs.mkdir(stateDirectory, { recursive: true })
  const previous = await readJson(stateFile, null)
  const lock = await acquireLock()
  if ('existing' in lock) {
    const result = { schemaVersion: 1, project: 'official-knowledge', mode, runId, state: 'skipped_locked', startedAt: now.toISOString(), lock: lock.existing }
    console.log(JSON.stringify(result))
    return
  }

  const startedAt = Date.now()
  try {
    const previousNextEligibleAt = Date.parse(previous?.nextEligibleAt ?? '')
    if (Number.isFinite(previousNextEligibleAt) && Date.now() < previousNextEligibleAt) {
      const result = {
        schemaVersion: 1,
        project: 'official-knowledge',
        mode,
        runId,
        state: 'skipped_not_due',
        startedAt: now.toISOString(),
        previousState: previous?.state ?? null,
        nextEligibleAt: previous.nextEligibleAt,
        privateDataAccessed: false,
        networkCollectionStarted: false,
        note: mode === 'public' ? '公开刷新尚未到下次 30 分钟检查时间；本次不读取公开包、不联网刷新或发布。' : '影子模式尚未到下次 30 分钟检查时间；本次不读取公开包、不联网刷新、不发布。',
      }
      await appendHistory(result)
      console.log(JSON.stringify(result))
      return
    }

    if (mode === 'public') {
      if (!publicRefreshApproved) {
        const result = { schemaVersion: 1, project: 'official-knowledge', mode, runId, state: 'blocked_public_refresh_not_approved', startedAt: now.toISOString(), privateDataAccessed: false, networkCollectionStarted: false, note: '公开官方资料刷新需要显式本机批准标志；未联网刷新。' }
        await appendHistory(result)
        console.log(JSON.stringify(result))
        process.exitCode = 2
        return
      }
      const previousPackage = await validatePublishedManifest()
      if (!previousPackage.ok) {
        const result = { schemaVersion: 1, project: 'official-knowledge', mode, runId, state: 'degraded', startedAt: now.toISOString(), preflight: { publishedPackage: previousPackage }, privateDataAccessed: false, networkCollectionStarted: false, note: '最后合格公开包校验失败；未联网刷新。' }
        await atomicJson(stateFile, result)
        await appendHistory(result)
        console.log(JSON.stringify(result))
        process.exitCode = 2
        return
      }
      const refresh = await runPublicRefresh()
      const packageValidation = await validatePublishedManifest()
      const result = {
        schemaVersion: 1, project: 'official-knowledge', mode, runId,
        state: refresh.exitCode === 0 && packageValidation.ok ? 'public_refresh_completed' : 'public_refresh_failed',
        startedAt: now.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
        intervalMinutes, previousState: previous?.state ?? null,
        preflight: { previousPackage }, publishedPackage: packageValidation,
        refresh: { exitCode: refresh.exitCode, timedOut: refresh.timedOut, outputBytes: refresh.outputBytes },
        nextEligibleAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
        privateDataAccessed: false, networkCollectionStarted: true,
        note: '仅刷新白名单中的 Meta、Facebook、Instagram 和 Shopify 公开官方资料；不读取真实账户、广告、客户、订单、Cookie、Token 或其他经营数据。',
      }
      await atomicJson(stateFile, result)
      await appendHistory(result)
      console.log(JSON.stringify(result))
      process.exitCode = result.state === 'public_refresh_completed' ? 0 : 2
      return
    }
    const packageValidation = await validatePublishedManifest()
    const preflightOk = packageValidation.ok
    const executable = mode === 'shadow' && preflightOk
    const result = {
      schemaVersion: 1,
      project: 'official-knowledge',
      mode,
      runId,
      state: executable ? 'shadow_completed' : (preflightOk ? 'blocked_active_not_implemented' : 'degraded'),
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
    process.exitCode = executable ? 0 : 2
  } finally {
    await lock.close()
    await fs.rm(lockFile, { force: true })
  }
}

await main()

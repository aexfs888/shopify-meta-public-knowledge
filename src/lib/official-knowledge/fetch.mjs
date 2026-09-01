import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ensureDir, exists, isoLocalFileStamp, isoTaipei, readJson, writeBufferAtomic,
  writeJsonAtomic, writeTextAtomic
} from '../fs-utils.mjs';
import {
  DEFAULT_USER_AGENT, FETCH_RETRIES, FETCH_TIMEOUT_MS, KNOWLEDGE_MANIFEST_ROOT,
  KNOWLEDGE_SOURCE_ROOT, MAX_SOURCE_BYTES
} from './constants.mjs';
import { extractTitle, htmlToMarkdown, normalizeWhitespace } from './normalize.mjs';
import { canonicalizeUrl, isAllowedOfficialUrl } from './urls.mjs';
import { loadOfficialSourceRegistry } from './registry.mjs';

export class OfficialFetchError extends Error {
  constructor(message, { status = null, code = 'fetch_failed', retryable = false } = {}) {
    super(message);
    this.name = 'OfficialFetchError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionFor(contentType) {
  if (/pdf/i.test(contentType)) return '.pdf';
  if (/json/i.test(contentType)) return '.json';
  if (/markdown/i.test(contentType)) return '.md';
  if (/plain/i.test(contentType)) return '.txt';
  return '.html';
}

function isSupportedContentType(contentType) {
  return /text\/html|text\/plain|text\/markdown|application\/json|[+]json|application\/pdf/i.test(contentType);
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOneAttempt(inputUrl, {
  fetchImpl = globalThis.fetch,
  requestHeaders = {},
  timeoutMs = FETCH_TIMEOUT_MS,
  maxRedirects = 6,
  maxBytes = MAX_SOURCE_BYTES
} = {}) {
  let url = canonicalizeUrl(inputUrl);
  if (!isAllowedOfficialUrl(url)) throw new OfficialFetchError(`已拒绝非官方网址：${inputUrl}`, { code: 'host_not_allowed' });

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/json,application/pdf,text/plain;q=0.9,*/*;q=0.1',
          ...requestHeaders
        }
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new OfficialFetchError(`官方页面请求超时：${url}`, { code: 'timeout', retryable: true });
      }
      throw new OfficialFetchError(`官方页面网络错误：${url}｜${error.message}`, { code: 'network', retryable: true });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new OfficialFetchError(`官方页面重定向缺少位置：${url}`, { status: response.status, code: 'bad_redirect' });
      // 请求跳转时保留服务器要求的末尾斜杠；canonicalizeUrl 用于来源身份去重，
      // 若在这里移除斜杠，某些官方文档站会反复把同一地址跳回带斜杠版本。
      const redirected = new URL(location, url).toString();
      if (!isAllowedOfficialUrl(redirected)) {
        throw new OfficialFetchError(`已阻止跳转到非官方域名：${redirected}`, { status: response.status, code: 'external_redirect' });
      }
      url = redirected;
      continue;
    }

    if (response.status === 304) return { status: 304, finalUrl: url, response };
    if ([401, 403, 429].includes(response.status)) {
      throw new OfficialFetchError(`官方页面返回 ${response.status}，已停止且不重复请求：${url}`, {
        status: response.status,
        code: response.status === 429 ? 'rate_limited' : 'access_blocked'
      });
    }
    if (response.status >= 500) {
      throw new OfficialFetchError(`官方页面暂时失败 ${response.status}：${url}`, {
        status: response.status, code: 'server_error', retryable: true
      });
    }
    if (!response.ok) {
      throw new OfficialFetchError(`官方页面返回 ${response.status}：${url}`, { status: response.status, code: 'http_error' });
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    if (!isSupportedContentType(contentType)) {
      throw new OfficialFetchError(`暂不支持的官方资料类型 ${contentType}：${url}`, { code: 'unsupported_content_type' });
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maxBytes) {
      throw new OfficialFetchError(`官方资料超过本地单文件上限 ${maxBytes} 字节：${url}`, { code: 'too_large' });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new OfficialFetchError(`官方资料实际大小超过本地上限 ${maxBytes} 字节：${url}`, { code: 'too_large' });
    }
    return { status: response.status, finalUrl: url, response, contentType, buffer };
  }
  throw new OfficialFetchError(`官方页面重定向次数过多：${inputUrl}`, { code: 'too_many_redirects' });
}

export async function fetchOfficialUrl(url, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : FETCH_RETRIES;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOneAttempt(url, options);
    } catch (error) {
      lastError = error;
      if (!(error instanceof OfficialFetchError) || !error.retryable || attempt >= retries) throw error;
      await (options.waitImpl ?? wait)(Math.min(4000, 300 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function normalizeFetchedContent({ contentType, buffer, fallbackTitle }) {
  if (/pdf/i.test(contentType)) return { title: fallbackTitle, normalized: '', binary: true };
  const rawText = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (/html/i.test(contentType)) {
    return { title: extractTitle(rawText, fallbackTitle), normalized: htmlToMarkdown(rawText), binary: false };
  }
  if (/json/i.test(contentType)) {
    try {
      return { title: fallbackTitle, normalized: JSON.stringify(JSON.parse(rawText), null, 2), binary: false };
    } catch {
      return { title: fallbackTitle, normalized: normalizeWhitespace(rawText), binary: false };
    }
  }
  if (/markdown/i.test(contentType)) return { title: fallbackTitle, normalized: normalizeWhitespace(rawText), binary: false };
  return { title: fallbackTitle, normalized: normalizeWhitespace(rawText), binary: false };
}

function assessNormalizedContent({ contentType, normalized }) {
  if (/pdf/i.test(contentType)) {
    return { usable: false, status: 'needs_text_extraction', reason: 'PDF 已保存，但尚未提取可检索正文。' };
  }
  const text = String(normalized ?? '').trim();
  const loginPatterns = [
    /please log in to see this page/i,
    /log in to (?:facebook|continue)/i,
    /登录.*(?:查看|继续|facebook)/i,
    /請登入.*(?:查看|繼續|facebook)/i
  ];
  if (loginPatterns.some((pattern) => pattern.test(text))) {
    return { usable: false, status: 'login_required', reason: '抓取结果是登录提示页，不是可用官方正文。' };
  }
  if (text.length < 300) {
    return { usable: false, status: 'content_too_short', reason: `规范化正文仅 ${text.length} 字符，疑似客户端空壳或拦截页。` };
  }
  return { usable: true, status: 'current', reason: null };
}

export async function syncOfficialSource(source, options = {}) {
  const sourceDir = path.join(options.sourceRoot ?? KNOWLEDGE_SOURCE_ROOT, source.source_id);
  const metaPath = path.join(sourceDir, 'source.json');
  const previous = await exists(metaPath) ? await readJson(metaPath) : null;
  const requestHeaders = {};
  if (previous?.etag) requestHeaders['if-none-match'] = previous.etag;
  if (previous?.last_modified) requestHeaders['if-modified-since'] = previous.last_modified;
  const startedAt = isoTaipei();
  const fetched = await fetchOfficialUrl(source.canonical_url, { ...options, requestHeaders: { ...requestHeaders, ...(options.requestHeaders ?? {}) } });

  if (fetched.status === 304 && previous) {
    const previouslyUsable = previous.quality?.usable_for_index !== false && ['current', 'changed'].includes(previous.status);
    const metadata = {
      ...previous,
      last_checked_at: isoTaipei(),
      status: previouslyUsable ? 'current' : previous.status,
      last_error: previouslyUsable ? null : previous.last_error
    };
    await writeJsonAtomic(metaPath, metadata);
    return { source_id: source.source_id, status: 'not_modified', metadata };
  }

  const contentHash = sha256Buffer(fetched.buffer);
  const extension = extensionFor(fetched.contentType);
  const rawPath = path.join(sourceDir, `raw${extension}`);
  const normalizedPath = path.join(sourceDir, 'normalized.md');
  const normalized = normalizeFetchedContent({ contentType: fetched.contentType, buffer: fetched.buffer, fallbackTitle: source.title_zh });
  const quality = assessNormalizedContent({ contentType: fetched.contentType, normalized: normalized.normalized });
  await ensureDir(sourceDir);
  await writeBufferAtomic(rawPath, fetched.buffer);
  if (quality.usable && normalized.normalized) await writeTextAtomic(normalizedPath, `${normalized.normalized.trim()}\n`);

  const metadata = {
    schema_version: 1,
    ...source,
    title: normalized.title || source.title_zh,
    final_url: fetched.finalUrl,
    content_type: fetched.contentType,
    content_hash: contentHash,
    content_bytes: fetched.buffer.length,
    local_raw_path: path.relative(options.workspaceRoot ?? path.resolve(KNOWLEDGE_SOURCE_ROOT, '..', '..', '..', '..'), rawPath),
    local_normalized_path: quality.usable && normalized.normalized ? path.relative(options.workspaceRoot ?? path.resolve(KNOWLEDGE_SOURCE_ROOT, '..', '..', '..', '..'), normalizedPath) : null,
    etag: fetched.response.headers.get('etag'),
    last_modified: fetched.response.headers.get('last-modified'),
    retrieved_at: startedAt,
    last_checked_at: isoTaipei(),
    status: quality.usable ? (previous && previous.content_hash !== contentHash ? 'changed' : 'current') : quality.status,
    quality: {
      usable_for_index: quality.usable,
      normalized_chars: normalized.normalized.length,
      reason: quality.reason
    },
    last_error: quality.reason
  };
  await writeJsonAtomic(metaPath, metadata);
  return { source_id: source.source_id, status: metadata.status, metadata };
}

export async function syncOfficialSources({ limit = Infinity, delayMs = 350, onlyMissing = false, retryErrors = false, ...options } = {}) {
  if (onlyMissing && retryErrors) throw new Error('onlyMissing 与 retryErrors 不能同时使用。');
  const registry = await loadOfficialSourceRegistry(options.configPath);
  const sourceRoot = options.sourceRoot ?? KNOWLEDGE_SOURCE_ROOT;
  const candidates = [];
  for (const source of registry.sources) {
    const metaPath = path.join(sourceRoot, source.source_id, 'source.json');
    const metadataExists = await exists(metaPath);
    if (onlyMissing && metadataExists) continue;
    if (retryErrors) {
      if (!metadataExists) continue;
      let metadata;
      try { metadata = await readJson(metaPath); } catch { metadata = { status: 'error' }; }
      if (metadata.status !== 'error') continue;
    }
    candidates.push(source);
  }
  const selected = candidates.slice(0, Math.max(0, Number(limit) || 0));
  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    const source = selected[index];
    try {
      results.push(await syncOfficialSource(source, options));
    } catch (error) {
      const sourceDir = path.join(options.sourceRoot ?? KNOWLEDGE_SOURCE_ROOT, source.source_id);
      const metaPath = path.join(sourceDir, 'source.json');
      let previous = null;
      try { if (await exists(metaPath)) previous = await readJson(metaPath); } catch { /* 保留本次错误证据即可 */ }
      // 无人值守刷新时，网络、限流或某次临时登录墙不应让已经通过质量
      // 检查的官方资料从知识库消失。保留最后一次可用正文，只登记本次失败，
      // 让审计和发布门槛处理异常；首次获取失败仍然保持 error，绝不伪造内容。
      const hasLastKnownGood = previous?.quality?.usable_for_index !== false
        && ['current', 'changed'].includes(previous?.status);
      if (hasLastKnownGood) {
        const retainedMetadata = {
          ...previous,
          ...source,
          title: previous.title || source.title_zh,
          last_checked_at: isoTaipei(),
          last_error: error.message,
          last_fetch_error: {
            at: isoTaipei(),
            code: error.code ?? 'unknown',
            http_status: error.status ?? null,
            message: error.message
          }
        };
        await writeJsonAtomic(metaPath, retainedMetadata);
        results.push({
          source_id: source.source_id,
          status: 'retained_previous',
          error: error.message,
          error_code: error.code ?? 'unknown',
          http_status: error.status ?? null
        });
      } else {
      await writeJsonAtomic(metaPath, {
        schema_version: 1,
        ...(previous ?? {}),
        ...source,
        title: previous?.title || source.title_zh,
        last_checked_at: isoTaipei(),
        status: 'error',
        last_error: error.message,
        error_code: error.code ?? 'unknown',
        http_status: error.status ?? null
      });
      results.push({
        source_id: source.source_id,
        status: 'error',
        error: error.message,
        error_code: error.code ?? 'unknown',
        http_status: error.status ?? null
      });
      }
    }
    if (index + 1 < selected.length && delayMs > 0) await (options.waitImpl ?? wait)(delayMs);
  }
  const manifest = {
    schema_version: 1,
    run_id: isoLocalFileStamp(),
    generated_at: isoTaipei(),
    selection_mode: onlyMissing ? 'missing_only' : (retryErrors ? 'errors_only' : 'all_registered'),
    selected_count: selected.length,
    success_count: results.filter((item) => ['current', 'changed', 'not_modified'].includes(item.status)).length,
    retained_previous_count: results.filter((item) => item.status === 'retained_previous').length,
    attention_count: results.filter((item) => item.status === 'retained_previous').length,
    error_count: results.filter((item) => item.status === 'error').length,
    results
  };
  const manifestRoot = options.manifestRoot ?? KNOWLEDGE_MANIFEST_ROOT;
  await ensureDir(manifestRoot);
  const manifestPath = path.join(manifestRoot, `sync-${manifest.run_id}.json`);
  await writeJsonAtomic(manifestPath, manifest);
  await writeJsonAtomic(path.join(manifestRoot, 'latest-sync.json'), manifest);
  return { manifest, manifestPath };
}

export async function readStoredRawHtml(sourceDir) {
  const filePath = path.join(sourceDir, 'raw.html');
  return await fsp.readFile(filePath, 'utf8');
}

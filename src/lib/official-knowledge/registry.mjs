import { readJson } from '../fs-utils.mjs';
import { SOURCE_CONFIG_PATH } from './constants.mjs';
import { canonicalizeUrl, isAllowedOfficialUrl, sourceIdForUrl } from './urls.mjs';

export async function loadOfficialSourceRegistry(configPath = SOURCE_CONFIG_PATH) {
  const config = await readJson(configPath);
  if (config.schema_version !== 1 || !Array.isArray(config.sources)) {
    throw new Error(`官方来源配置格式无效：${configPath}`);
  }
  const seen = new Set();
  const sources = [];
  for (const [index, item] of config.sources.entries()) {
    if (!item || typeof item.url !== 'string' || typeof item.publisher !== 'string') {
      throw new Error(`官方来源第 ${index + 1} 项缺少 url 或 publisher。`);
    }
    const canonicalUrl = canonicalizeUrl(item.url);
    if (!isAllowedOfficialUrl(canonicalUrl)) {
      throw new Error(`官方来源不在白名单或不是安全 HTTPS：${item.url}`);
    }
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    sources.push({
      source_id: item.source_id ?? sourceIdForUrl(canonicalUrl, item.publisher),
      publisher: item.publisher,
      title_zh: item.title_zh ?? '',
      canonical_url: canonicalUrl,
      type: item.type ?? 'help',
      language: item.language ?? inferLanguage(canonicalUrl),
      modules: Array.isArray(item.modules) ? [...new Set(item.modules.map(String))] : [],
      archive_mode: item.archive_mode ?? 'local_research_copy',
      rights_status: item.rights_status ?? 'personal_local_research',
      volatility: item.volatility ?? inferVolatility(item.type)
    });
  }
  return { ...config, sources };
}

function inferLanguage(url) {
  if (/locale=zh|\/zh[-_]/i.test(url)) return 'zh-CN';
  return 'en';
}

function inferVolatility(type) {
  if (['changelog', 'developer', 'help'].includes(type)) return 'high';
  if (type === 'policy') return 'medium';
  return 'medium';
}


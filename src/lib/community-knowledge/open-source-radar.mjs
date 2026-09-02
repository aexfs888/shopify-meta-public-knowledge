import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir, exists, isoTaipei, readJson, writeJsonAtomic } from '../fs-utils.mjs';
import { workspacePath } from '../paths.mjs';

export const COMMUNITY_ROOT = workspacePath('knowledge', 'community', 'meta-shopify', 'open-source');
export const COMMUNITY_CATALOG_PATH = path.join(COMMUNITY_ROOT, 'catalog.json');
export const COMMUNITY_DB_PATH = path.join(COMMUNITY_ROOT, 'index', 'community.sqlite');
export const FRONTIER_ROOT = path.join(COMMUNITY_ROOT, 'frontier');
export const FRONTIER_CATALOG_PATH = path.join(FRONTIER_ROOT, 'latest-30-days.json');
export const FRONTIER_DB_PATH = path.join(FRONTIER_ROOT, 'index', 'frontier.sqlite');
export const COMPLIANCE_RISK_ROOT = path.join(COMMUNITY_ROOT, 'compliance-risk');
export const COMPLIANCE_RISK_REGISTRY_PATH = path.join(COMPLIANCE_RISK_ROOT, 'isolated-risk-registry.json');
export const COMPLIANCE_RISK_HISTORY_PATH = path.join(COMPLIANCE_RISK_ROOT, 'screening-history.json');
export const COMMUNITY_CONFIG_PATH = workspacePath('config', 'community-open-source-discovery.json');
const GITHUB_API = 'https://api.github.com/search/repositories';
const GITLAB_API = 'https://gitlab.com/api/v4/projects';

function communityDbPathFor(catalogPath) {
  if (path.resolve(catalogPath) === path.resolve(COMMUNITY_CATALOG_PATH)) return COMMUNITY_DB_PATH;
  if (path.resolve(catalogPath) === path.resolve(FRONTIER_CATALOG_PATH)) return FRONTIER_DB_PATH;
  return path.join(path.dirname(catalogPath), 'index', 'community.sqlite');
}

function sourceId(fullName) {
  return `oss-${crypto.createHash('sha256').update(String(fullName).toLowerCase()).digest('hex').slice(0, 16)}`;
}

function normalizeLicense(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const aliases = { mit: 'MIT', 'apache-2.0': 'Apache-2.0', 'apache-2': 'Apache-2.0', 'bsd-2-clause': 'BSD-2-Clause', 'bsd-3-clause': 'BSD-3-Clause', 'mpl-2.0': 'MPL-2.0', isc: 'ISC', 'lgpl-3.0': 'LGPL-3.0', 'gpl-3.0': 'GPL-3.0' };
  return aliases[key] ?? (key ? value : 'NOASSERTION');
}

function daysSince(value, now = new Date()) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? Math.max(0, (now.getTime() - ms) / 86_400_000) : Infinity;
}

function relevanceText(repo) {
  return [repo.full_name, repo.name, repo.description, ...(repo.topics ?? [])].filter(Boolean).join(' ').toLowerCase();
}

function isMetaPlatformRelevant(text) {
  if (/\b(?:facebook|instagram)\b/.test(text)) return true;
  // “meta-harness”“metadata”等泛用术语不是 Meta Business；必须同时出现投放、
  // 信号、营销或官方 Graph API 等业务语境，才视为 FB+BM 相关。
  return /\bmeta\b/.test(text) && /\b(?:ads?|advertis(?:ing)?|marketing|business|campaigns?|pixel|conversion|capi|ad[ -]?library|graph api)\b/.test(text);
}

function isShopifyPlatformRelevant(text) {
  return /\b(?:shopify|hydrogen)\b/.test(text);
}

function classifyTopics(repo) {
  const text = relevanceText(repo);
  const matched = [];
  const rules = [
    ['tracking', /conversion|capi|pixel|event|web.?pixel/],
    ['campaigns', /marketing.?api|campaign|ads?\b|advertis/],
    ['shopify', /\b(?:shopify|hydrogen)\b/],
    ['catalog', /catalog|feed|product.?ads?|dynamic.?product/],
    ['creative', /creative|copy|reels|image.?gen/],
    ['reporting', /insight|report|analyt|attribution|measurement/],
    ['automation', /mcp|agent|automat|workflow/]
  ];
  for (const [topic, expression] of rules) if (expression.test(text)) matched.push(topic);
  return matched;
}

const COMPLIANCE_RISK_CATEGORIES = [
  {
    key: 'account_evasion',
    terms: ['anti-detect', 'antidetect', 'fingerprint spoof', 'account farm', 'account warming', 'ban evasion', 'policy bypass', 'stealth browser'],
    category_zh: '账号、身份或平台限制规避',
    risk_zh: '可能违反平台条款并触发账号、资产或支付限制。',
    safe_alternative_zh: '使用官方 OAuth、正式权限、真实业务资料和平台申诉/支持渠道；发生限制时先停用自动化并核对官方提示。'
  },
  {
    key: 'access_bypass',
    terms: ['captcha bypass', 'login bypass', 'private scraper'],
    category_zh: '验证码或访问限制绕过',
    risk_zh: '属于规避访问控制，可能违法或违反服务条款。',
    safe_alternative_zh: '只使用公开 API、RSS、站点地图或已获授权的数据导出；遇到验证码、登录或付费墙立即停止。'
  },
  {
    key: 'credential_misuse',
    terms: ['cookie theft', 'cookie stealer', 'credential theft', 'token stealer'],
    category_zh: '凭据、Cookie 或会话数据滥用',
    risk_zh: '可能造成未授权访问、数据泄露与账户接管。',
    safe_alternative_zh: '凭据只保存在官方安全授权存储；不导出、不复制 Cookie 或 Token，并定期撤销失效授权。'
  },
  {
    key: 'advertising_integrity',
    terms: ['ad review bypass', 'misleading claims', 'fake engagement', 'click fraud'],
    category_zh: '广告审核、内容真实性与互动完整性风险',
    risk_zh: '可能导致广告拒登、停投、账户处罚或消费者误导。',
    safe_alternative_zh: '广告文案、素材、落地页和商品声明均以 Meta 广告标准及实际可验证证据复核；不伪造评价、互动、折扣或功效。'
  },
  {
    key: 'privacy_and_data_governance',
    terms: ['consent bypass', 'data exfiltration', 'pii scraper', 'customer list leak'],
    category_zh: '隐私、同意与客户数据治理风险',
    risk_zh: '可能违反隐私承诺、平台条款或数据保护法律，并损害客户权益。',
    safe_alternative_zh: '先取得适用的同意与合法依据；最小化收集；遵守退订、删除和数据访问请求；只用官方或获授权接口。'
  },
  {
    key: 'product_and_consumer_safety',
    terms: ['unsafe product', 'prohibited product', 'counterfeit product'],
    category_zh: '商品、消费者安全与受限品类风险',
    risk_zh: '可能引发下架、退款、召回、监管处罚或消费者伤害。',
    safe_alternative_zh: '上架前完成商品身份、合规标签、警示、运输限制、目标国规则和供应链证据检查。'
  },
  {
    key: 'intellectual_property_and_content_rights',
    terms: ['trademark infringement', 'brand impersonation', 'watermark removal', 'drm cracking'],
    category_zh: '商标、版权与素材权利风险',
    risk_zh: '可能造成投诉、下架、账户限制、赔偿或纠纷。',
    safe_alternative_zh: '只使用已验证授权的商品、商标和图片视频；保留许可、署名和授权范围证据。'
  },
  {
    key: 'measurement_integrity',
    terms: ['fake conversion', 'event spoofing', 'metric manipulation'],
    category_zh: '追踪、归因与指标真实性风险',
    risk_zh: '会误导优化决策、破坏平台信号质量，并可能违反平台或合同要求。',
    safe_alternative_zh: '只发送真实业务事件；使用官方 Pixel/CAPI 去重、同意和数据质量规则，并以订单、退款和支付记录复核。'
  }
];

const COMPLIANCE_OFFICIAL_EVIDENCE = [
  { publisher: 'Meta', title_zh: 'Meta 广告标准', url: 'https://transparency.meta.com/policies/ad-standards/' },
  { publisher: 'Meta', title_zh: 'Meta Business Tools Terms', url: 'https://www.facebook.com/legal/technology_terms' },
  { publisher: 'Meta', title_zh: 'Meta Commercial Terms', url: 'https://www.facebook.com/legal/commercial_terms' },
  { publisher: 'Meta', title_zh: 'Customer List Custom Audiences Terms', url: 'https://www.facebook.com/legal/terms/customaudience' },
  { publisher: 'Shopify', title_zh: 'Shopify 顾客隐私设置', url: 'https://help.shopify.com/en/manual/privacy-and-security/privacy/customer-privacy-settings/privacy-settings' },
  { publisher: 'Shopify', title_zh: 'Shopify Web Pixel 隐私', url: 'https://shopify.dev/docs/api/web-pixels-api/pixel-privacy' }
];

function normalizedUnsafeTerms(unsafeTerms = []) {
  return unsafeTerms.map((term) => String(term ?? '').trim().toLowerCase()).filter(Boolean);
}

function isUnsafeRepository(text, unsafeTerms = []) {
  return normalizedUnsafeTerms(unsafeTerms).find((term) => text.includes(term)) ?? null;
}

function complianceRiskForUnsafeTerm(term) {
  const normalized = String(term ?? '').toLowerCase();
  return COMPLIANCE_RISK_CATEGORIES.find((item) => item.terms.includes(normalized))
    ?? { key: 'other_platform_abuse', category_zh: '其他平台滥用风险', risk_zh: '不适合进入正常技术评估流程。', safe_alternative_zh: '停止收集并以官方规则、授权接口和人工复核替代。' };
}

export function scoreOpenSourceRepository(repo, { allowedLicenses = [], freshWithinDays = 30, maximumAgeDays = 180, unsafeTerms = [], now = new Date() } = {}) {
  const license = normalizeLicense(repo.license?.spdx_id ?? repo.license?.key);
  const text = relevanceText(repo);
  const topics = classifyTopics(repo);
  const reasons = [];
  let score = 0;
  if (repo.archived || repo.fork || repo.disabled) return { score: -99, reasons: ['归档、Fork 或已禁用项目'], topics, license };
  const unsafeTerm = isUnsafeRepository(text, unsafeTerms);
  if (unsafeTerm) {
    const risk = complianceRiskForUnsafeTerm(unsafeTerm);
    return { score: -99, reasons: ['命中违规风险隔离规则'], topics, license, risk_category_key: risk.key, risk_category_zh: risk.category_zh };
  }
  if (!isMetaPlatformRelevant(text) && !isShopifyPlatformRelevant(text)) {
    return { score: -99, reasons: ['公开元数据未明确关联 Meta/Facebook/Instagram 或 Shopify/Hydrogen'], topics, license };
  }
  if (!allowedLicenses.includes(license)) return { score: -99, reasons: [`许可证 ${license} 不在允许清单`], topics, license };
  score += 3; reasons.push(`许可证 ${license}`);
  // 按仓库“更新时间”筛选；GitHub API 的 updated_at 是用户可见的更新时间。
  const ageDays = Math.floor(daysSince(repo.updated_at, now));
  if (!Number.isFinite(ageDays) || ageDays > maximumAgeDays) return { score: -99, reasons: [`超过 ${maximumAgeDays} 天未更新`], topics, license, age_days: ageDays };
  if (ageDays <= freshWithinDays) { score += 3; reasons.push(`最近 ${ageDays} 天更新（新技术）`); }
  else { score += 2; reasons.push(`最后更新距今 ${ageDays} 天（超过一个月，半年内）`); }
  if (Number(repo.stargazers_count ?? 0) >= 20) { score += 2; reasons.push('有基础社区关注'); }
  else if (Number(repo.stargazers_count ?? 0) >= 3) { score += 1; reasons.push('已有公开使用者关注'); }
  if (topics.includes('shopify')) { score += 2; reasons.push('直接涉及 Shopify'); }
  if (topics.includes('tracking') || topics.includes('campaigns')) { score += 2; reasons.push('涉及 Meta 投流或信号'); }
  if (topics.includes('automation')) { score += 1; reasons.push('涉及自动化或 AI 助手'); }
  // Shopify 原生扩展、Functions 和智能体并不一定在名称中写 Meta；只要命中 Shopify
  // 且已匹配到本雷达主题，就保留为需要官方核验的候选，避免漏掉近月前沿技术。
  const platformRelevant = isMetaPlatformRelevant(text) || (isShopifyPlatformRelevant(text) && topics.length >= 2);
  if (!platformRelevant) score -= 3;
  return { score, reasons, topics, license, age_days: ageDays, freshness: ageDays <= freshWithinDays ? 'fresh_within_30_days' : 'updated_within_180_days' };
}

function compactRepository(repo, quality, query, provider = 'GitHub') {
  return {
    source_id: sourceId(repo.full_name),
    source_tier: 'community_open_source',
    publisher: `${provider} / ${repo.owner?.login ?? 'unknown'}`,
    provider,
    repository: repo.full_name,
    title_zh: `开源项目：${repo.full_name}`,
    description_original: repo.description ?? '',
    canonical_url: repo.html_url,
    homepage_url: repo.homepage || null,
    default_branch: repo.default_branch ?? null,
    language: repo.language ?? null,
    license_spdx: quality.license,
    topics: [...new Set([...(repo.topics ?? []), ...quality.topics])],
    stars: Number(repo.stargazers_count ?? 0),
    forks: Number(repo.forks_count ?? 0),
    hotness_score: Math.round((Number(repo.stargazers_count ?? 0) + Number(repo.forks_count ?? 0) * 0.35) * 100) / 100,
    open_issues: Number(repo.open_issues_count ?? 0),
    pushed_at: repo.pushed_at ?? null,
    updated_at: repo.updated_at ?? null,
    age_days: quality.age_days,
    freshness: quality.freshness,
    freshness_label_zh: quality.freshness === 'fresh_within_30_days' ? '最近 30 天更新：新技术候选' : `超过一个月、半年内：最后更新距今 ${quality.age_days} 天`,
    quality_score: quality.score,
    selection_reasons_zh: quality.reasons,
    discovery_query: query,
    adoption_rule_zh: '只作第三方技术参考；先用 Meta/Shopify 官方资料核验，再决定是否在本机隔离试用。不得把账户 Token、客户数据或真实广告写入第三方工具。',
    status: 'candidate_verified_metadata'
  };
}

const FRONTIER_CATEGORY_LABELS = {
  tracking: '服务端追踪与转化信号',
  campaigns: '营销自动化与广告投放',
  shopify: 'Shopify 原生扩展与店铺能力',
  catalog: '商品目录、数据源与动态商品广告',
  creative: '广告创意与生成式 AI',
  reporting: '归因、增量与数据分析',
  automation: 'AI 智能体、MCP 与工作流自动化'
};

function frontierSettings(config = {}) {
  const value = config.frontier ?? {};
  const maximumAgeDays = Number(value.maximum_age_days ?? config.github?.fresh_within_days ?? 30);
  return {
    maximumAgeDays: Number.isFinite(maximumAgeDays) && maximumAgeDays > 0 ? maximumAgeDays : 30,
    minimumQualityScore: Number(value.minimum_quality_score ?? config.github?.minimum_quality_score ?? 7)
  };
}

function frontierCategories(topics = []) {
  const labels = topics.map((topic) => FRONTIER_CATEGORY_LABELS[topic]).filter(Boolean);
  return labels.length ? [...new Set(labels)] : ['待人工判断的前沿技术方向'];
}

export async function buildComplianceRiskRegistry({
  observations = new Map(),
  registryPath = COMPLIANCE_RISK_REGISTRY_PATH,
  historyPath = path.join(path.dirname(registryPath), 'screening-history.json'),
  now = new Date()
} = {}) {
  const categories = COMPLIANCE_RISK_CATEGORIES.map((item) => {
    const observation = observations.get(item.key);
    const count = typeof observation === 'number' ? observation : Number(observation?.count ?? 0);
    return {
      category_id: item.key,
      category_zh: item.category_zh,
      observed_candidate_count: count,
      observed_source_providers: [...(observation?.providers ?? [])].sort(),
      observed_business_contexts_zh: [...(observation?.contexts ?? [])].sort(),
      risk_zh: item.risk_zh,
      safe_alternative_zh: item.safe_alternative_zh,
      handling_zh: '只计入匿名聚合计数与非操作性场景；不保存项目名称、链接、代码、下载物或操作步骤。'
    };
  });
  const registry = {
    schema_version: 1,
    source_tier: 'compliance_risk_research',
    generated_at: isoTaipei(now),
    purpose_zh: '用于正常工作流的合规筛查、培训和风险规避，不用于发现、使用或传播违规工具。',
    coverage_zh: '覆盖账号与访问、广告完整性、隐私数据、商品安全、知识产权、追踪归因等八大风险类；类别会随公开官方资料的更新而复核。',
    data_handling_zh: '仅保留风险类别和匿名聚合计数；不保存可操作的违规项目标识、URL、代码、凭据或规避步骤。',
    evidence_boundary_zh: '官方规则是判定依据；匿名命中数只表示本次合规公开技术检索中被拦截的数量，不代表全网发生率。',
    official_evidence: COMPLIANCE_OFFICIAL_EVIDENCE,
    normal_use_checklist_zh: [
      '新增工具、素材、数据源或自动化前，先选择对应风险类别并核对官方规则。',
      '涉及客户数据、Pixel、CAPI、受众或 Cookie 时，先核对同意、最小化收集和授权边界。',
      '涉及广告、商品或素材时，核对真实声明、商品安全、地区要求、商标和授权证据。',
      '一旦命中风险类别，停止接入；记录原因并改用官方接口、授权资料或人工复核。'
    ],
    observed_candidate_count: categories.reduce((total, item) => total + item.observed_candidate_count, 0),
    categories
  };
  await writeJsonAtomic(registryPath, registry);
  const history = await appendComplianceRiskHistory({ registry, historyPath, now });
  return { registry, registryPath, history };
}

export async function appendComplianceRiskHistory({
  registry = null,
  registryPath = COMPLIANCE_RISK_REGISTRY_PATH,
  historyPath = COMPLIANCE_RISK_HISTORY_PATH,
  now = new Date()
} = {}) {
  const source = registry ?? await readJson(registryPath);
  if (source.schema_version !== 1 || source.source_tier !== 'compliance_risk_research') throw new Error('违规风险研究隔离库格式无效，不能写入趋势历史。');
  const run = {
    observed_at: source.generated_at ?? isoTaipei(now),
    observed_candidate_count: Number(source.observed_candidate_count ?? 0),
    categories: (source.categories ?? []).map((item) => ({
      category_id: item.category_id,
      category_zh: item.category_zh,
      observed_candidate_count: Number(item.observed_candidate_count ?? 0),
      observed_source_providers: item.observed_source_providers ?? [],
      observed_business_contexts_zh: item.observed_business_contexts_zh ?? []
    }))
  };
  const previous = await exists(historyPath) ? await readJson(historyPath) : { schema_version: 1, source_tier: 'compliance_risk_history', runs: [] };
  const retained = (previous.runs ?? []).filter((item) => item.observed_at !== run.observed_at).slice(-729);
  retained.push(run);
  const history = {
    schema_version: 1,
    source_tier: 'compliance_risk_history',
    retention_zh: '保留最近 730 次有效筛查快照；每条仅含匿名聚合风险数据。',
    updated_at: isoTaipei(now),
    run_count: retained.length,
    runs: retained
  };
  await writeJsonAtomic(historyPath, history);
  return { historyPath, runCount: history.run_count };
}

export async function buildFrontierCatalog({
  catalogPath = COMMUNITY_CATALOG_PATH,
  frontierCatalogPath = FRONTIER_CATALOG_PATH,
  catalog = null,
  config = null,
  configPath = COMMUNITY_CONFIG_PATH,
  now = new Date()
} = {}) {
  const source = catalog ?? await readJson(catalogPath);
  const resolvedConfig = config ?? await readJson(configPath);
  const settings = frontierSettings(resolvedConfig);
  const repositories = (source.repositories ?? [])
    .filter((item) => Number(item.age_days) >= 0 && Number(item.age_days) <= settings.maximumAgeDays && Number(item.quality_score) >= settings.minimumQualityScore)
    .map((item) => ({
      ...item,
      frontier_categories_zh: frontierCategories(item.topics),
      frontier_window_days: settings.maximumAgeDays,
      frontier_status_zh: `近 ${settings.maximumAgeDays} 天更新的前沿技术候选；须先按官方规则和本机隔离环境核验。`,
      status: 'frontier_candidate_metadata'
    }))
    // 近月雷达按更新时间优先，避免老牌高 Star 项目掩盖刚出现的技术。
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.quality_score - a.quality_score || b.hotness_score - a.hotness_score || a.repository.localeCompare(b.repository));
  const frontier = {
    schema_version: 1,
    scope_zh: `${source.scope_zh}；仅展示近 ${settings.maximumAgeDays} 天更新的前沿技术候选。`,
    source_tier: 'community_open_source',
    catalog_kind: 'frontier_latest_30_days',
    generated_at: isoTaipei(now),
    parent_catalog_generated_at: source.generated_at ?? null,
    provider: source.provider ?? 'GitHub and GitLab public repository metadata APIs',
    metadata_only: true,
    maximum_age_days: settings.maximumAgeDays,
    repository_count: repositories.length,
    safety: source.safety,
    repositories
  };
  await writeJsonAtomic(frontierCatalogPath, frontier);
  const index = await buildCommunityIndex({ catalog: frontier, catalogPath: frontierCatalogPath });
  return { catalog: frontier, catalogPath: frontierCatalogPath, index };
}

async function githubSearch(query, { fetchImpl = fetch, token, perPage = 40 } = {}) {
  const url = new URL(GITHUB_API);
  url.searchParams.set('q', query);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(Math.min(100, Math.max(1, perPage))));
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Hermes-Open-Source-Radar/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`GitHub 公开仓库搜索失败：HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.items) ? payload.items : [];
}

function normalizeGitLabRepository(project) {
  return {
    full_name: project.path_with_namespace,
    name: project.name,
    description: project.description,
    html_url: project.web_url,
    homepage: project.web_url,
    owner: { login: project.namespace?.full_path ?? project.namespace?.path ?? 'unknown' },
    archived: Boolean(project.archived),
    fork: Boolean(project.forked_from_project),
    disabled: false,
    license: project.license ?? null,
    topics: project.topics ?? project.tag_list ?? [],
    stargazers_count: Number(project.star_count ?? 0),
    forks_count: Number(project.forks_count ?? 0),
    open_issues_count: 0,
    pushed_at: project.last_activity_at ?? project.updated_at ?? null,
    updated_at: project.updated_at ?? project.last_activity_at ?? null,
    default_branch: project.default_branch ?? null,
    language: null
  };
}

async function gitlabSearch(query, { fetchImpl = fetch, perPage = 40 } = {}) {
  const url = new URL(GITLAB_API);
  url.searchParams.set('search', query);
  url.searchParams.set('visibility', 'public');
  url.searchParams.set('order_by', 'updated_at');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('license', 'true');
  url.searchParams.set('per_page', String(Math.min(100, Math.max(1, perPage))));
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'Hermes-Open-Source-Radar/1.0' }, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`GitLab 公开项目搜索失败：HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload.map(normalizeGitLabRepository) : [];
}

export async function discoverOpenSourceTechnology({
  configPath = COMMUNITY_CONFIG_PATH,
  catalogPath = COMMUNITY_CATALOG_PATH,
  frontierCatalogPath = path.join(path.dirname(catalogPath), 'frontier', 'latest-30-days.json'),
  riskRegistryPath = path.join(path.dirname(catalogPath), 'compliance-risk', 'isolated-risk-registry.json'),
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN || '',
  now = new Date()
} = {}) {
  const config = await readJson(configPath);
  if (config.schema_version !== 1 || !config.github || !Array.isArray(config.github.queries)) {
    throw new Error(`开源技术雷达配置无效：${configPath}`);
  }
  const previous = await exists(catalogPath) ? await readJson(catalogPath) : null;
  const warnings = [];
  const candidates = new Map();
  const riskObservations = new Map();
  const observedRiskSources = new Map();
  let searched = 0;
  async function collect(provider, query, search, providerConfig) {
    try {
      const items = await search(query, { fetchImpl, token, perPage: providerConfig.max_results_per_query });
      searched += 1;
      for (const repo of items) {
        const quality = scoreOpenSourceRepository(repo, {
          allowedLicenses: providerConfig.allowed_licenses,
          freshWithinDays: Number(providerConfig.fresh_within_days ?? 30),
          maximumAgeDays: Number(providerConfig.maximum_age_days ?? 180),
          unsafeTerms: config.safety?.excluded_terms ?? [],
          now
        });
        if (quality.risk_category_key) {
          const sourceKey = sourceId(repo.full_name);
          const seenSources = observedRiskSources.get(quality.risk_category_key) ?? new Set();
          if (!seenSources.has(sourceKey)) {
            seenSources.add(sourceKey);
            observedRiskSources.set(quality.risk_category_key, seenSources);
            const observation = riskObservations.get(quality.risk_category_key) ?? { count: 0, providers: new Set(), contexts: new Set() };
            observation.count += 1;
            observation.providers.add(provider);
            observation.contexts.add('Meta/Shopify 相关公开开源技术筛选');
            for (const context of frontierCategories(quality.topics)) observation.contexts.add(context);
            riskObservations.set(quality.risk_category_key, observation);
          }
        }
        if (quality.score < Number(providerConfig.minimum_quality_score ?? 7)) continue;
        const card = compactRepository(repo, quality, query, provider);
        const existing = candidates.get(card.source_id);
        if (!existing || card.quality_score > existing.quality_score) candidates.set(card.source_id, card);
      }
    } catch (error) {
      warnings.push({ provider, query, error: error.message });
    }
  }
  if (config.providers?.includes('github') !== false) for (const query of config.github.queries) await collect('GitHub', query, githubSearch, config.github);
  if (config.providers?.includes('gitlab') && config.gitlab) for (const query of config.gitlab.queries) await collect('GitLab', query, gitlabSearch, config.gitlab);
  if (searched === 0 && previous) return { catalog: previous, retained_previous: true, warnings };
  if (searched === 0) throw new Error(`所有 GitHub 搜索均失败：${warnings.map((item) => item.error).join('；')}`);
  // 通过硬性合格门槛后，按公开热度由高到低显示；更新时间只用于同热度时的稳定排序。
  const repositories = [...candidates.values()].sort((a, b) => b.hotness_score - a.hotness_score || b.quality_score - a.quality_score || String(b.updated_at).localeCompare(String(a.updated_at)) || a.repository.localeCompare(b.repository));
  const catalog = {
    schema_version: 1,
    scope_zh: config.scope_zh,
    source_tier: 'community_open_source',
    generated_at: isoTaipei(now),
    provider: 'GitHub public repository metadata API',
    metadata_only: true,
    searched_queries: searched,
    repository_count: repositories.length,
    warnings,
    safety: config.safety,
    repositories
  };
  await writeJsonAtomic(catalogPath, catalog);
  const index = await buildCommunityIndex({ catalog, catalogPath });
  const frontier = await buildFrontierCatalog({ catalog, config, frontierCatalogPath, now });
  const riskRegistry = await buildComplianceRiskRegistry({ observations: riskObservations, registryPath: riskRegistryPath, now });
  return { catalog, catalogPath, index, frontier, riskRegistry, retained_previous: false, warnings };
}

const CHINESE_QUERY_MAP = {
  像素: ['pixel', 'webpixel', 'tracking'], 转化: ['conversion', 'capi', 'tracking'], 去重: ['deduplication', 'capi', 'pixel'],
  广告: ['ads', 'campaigns', 'marketing'], 广告系列: ['campaigns'], 商品: ['shopify', 'catalog'], 目录: ['catalog', 'feed'],
  自动化: ['automation', 'mcp', 'agent'], 智能体: ['agent', 'mcp'], 归因: ['attribution', 'measurement'], 创意: ['creative', 'reels']
};

export async function buildCommunityIndex({ catalogPath = COMMUNITY_CATALOG_PATH, dbPath = null, catalog = null } = {}) {
  dbPath ??= communityDbPathFor(catalogPath);
  const source = catalog ?? await readJson(catalogPath);
  await ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      source_id TEXT PRIMARY KEY, provider TEXT NOT NULL, repository TEXT NOT NULL UNIQUE,
      title_zh TEXT NOT NULL, description_original TEXT NOT NULL, canonical_url TEXT NOT NULL,
      license_spdx TEXT NOT NULL, stars INTEGER NOT NULL, forks INTEGER NOT NULL, hotness_score REAL NOT NULL,
      updated_at TEXT, age_days INTEGER NOT NULL, freshness TEXT NOT NULL, quality_score REAL NOT NULL,
      topics_json TEXT NOT NULL, card_json TEXT NOT NULL, indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_hotness ON projects(hotness_score DESC, updated_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(source_id UNINDEXED, repository, description_original, topics, tokenize='unicode61 remove_diacritics 2');
  `);
  try {
    db.exec('BEGIN IMMEDIATE; DELETE FROM projects_fts; DELETE FROM projects;');
    const insert = db.prepare(`INSERT INTO projects(source_id,provider,repository,title_zh,description_original,canonical_url,license_spdx,stars,forks,hotness_score,updated_at,age_days,freshness,quality_score,topics_json,card_json,indexed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertFts = db.prepare('INSERT INTO projects_fts(source_id,repository,description_original,topics) VALUES(?,?,?,?)');
    for (const item of source.repositories ?? []) {
      insert.run(item.source_id, item.provider ?? item.publisher ?? 'unknown', item.repository, item.title_zh ?? item.repository, item.description_original ?? '', item.canonical_url, item.license_spdx ?? 'NOASSERTION', Number(item.stars ?? 0), Number(item.forks ?? 0), Number(item.hotness_score ?? 0), item.updated_at ?? null, Number(item.age_days ?? 9999), item.freshness ?? 'unknown', Number(item.quality_score ?? 0), JSON.stringify(item.topics ?? []), JSON.stringify(item), source.generated_at ?? isoTaipei());
      insertFts.run(item.source_id, item.repository, item.description_original ?? '', (item.topics ?? []).join(' '));
    }
    db.prepare(`INSERT INTO schema_meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    db.prepare(`INSERT INTO schema_meta(key,value) VALUES('catalog_generated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(source.generated_at ?? '');
    db.exec('COMMIT');
    return { dbPath, projectCount: (source.repositories ?? []).length };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no-op */ }
    throw error;
  } finally { db.close(); }
}

async function readCommunityCards({ catalogPath, dbPath }) {
  if (await exists(dbPath)) {
    const db = new DatabaseSync(dbPath);
    try { return db.prepare('SELECT card_json FROM projects ORDER BY hotness_score DESC, updated_at DESC').all().map((row) => JSON.parse(row.card_json)); }
    finally { db.close(); }
  }
  if (!(await exists(catalogPath))) return [];
  return (await readJson(catalogPath)).repositories ?? [];
}

export async function searchOpenSourceTechnology(query, { catalogPath = COMMUNITY_CATALOG_PATH, dbPath = null, limit = 5 } = {}) {
  dbPath ??= communityDbPathFor(catalogPath);
  const repositories = await readCommunityCards({ catalogPath, dbPath });
  const original = String(query ?? '').toLowerCase().trim();
  const tokens = new Set(original.split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2));
  for (const [zh, aliases] of Object.entries(CHINESE_QUERY_MAP)) if (original.includes(zh)) aliases.forEach((item) => tokens.add(item));
  return repositories.map((item) => {
    const haystack = [item.repository, item.description_original, ...(item.topics ?? [])].join(' ').toLowerCase();
    const hits = [...tokens].filter((token) => haystack.includes(token));
    return { ...item, query_match_count: hits.length, matched_terms: hits };
  }).filter((item) => item.query_match_count > 0)
    .sort((a, b) => b.query_match_count - a.query_match_count || b.hotness_score - a.hotness_score || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, Math.max(1, Math.min(12, Number(limit) || 5)));
}

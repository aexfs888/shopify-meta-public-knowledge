import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir, exists, isoTaipei, readJson, writeJsonAtomic, writeTextAtomic } from '../fs-utils.mjs';
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
export const RESEARCH_SOURCE_LEDGER_PATH = path.join(COMMUNITY_ROOT, 'research-sources', 'source-ledger.json');
export const COMMUNITY_RESEARCH_REPORT_PATH = workspacePath('reports', 'public', '开源技术雷达-最新研究报告.md');
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
    safe_alternative_zh: '使用官方 OAuth、正式权限、真实业务资料和平台申诉/支持渠道；发生限制时先停用自动化并核对官方提示。',
    defensive_signals_zh: ['要求共享 Cookie、Token、恢复资料或使用与业务主体不一致的身份。', '要求以规避平台限制为卖点，而非通过官方支持或申诉处理。']
  },
  {
    key: 'access_bypass',
    terms: ['captcha bypass', 'login bypass', 'private scraper'],
    category_zh: '验证码或访问限制绕过',
    risk_zh: '属于规避访问控制，可能违法或违反服务条款。',
    safe_alternative_zh: '只使用公开 API、RSS、站点地图或已获授权的数据导出；遇到验证码、登录或付费墙立即停止。',
    defensive_signals_zh: ['数据源需要登录、验证码、付费墙或私有权限，却声称可自动批量读取。', '没有公开 API 或书面授权，仍要求接入私人后台或受限页面。']
  },
  {
    key: 'credential_misuse',
    terms: ['cookie theft', 'cookie stealer', 'credential theft', 'token stealer'],
    category_zh: '凭据、Cookie 或会话数据滥用',
    risk_zh: '可能造成未授权访问、数据泄露与账户接管。',
    safe_alternative_zh: '凭据只保存在官方安全授权存储；不导出、不复制 Cookie 或 Token，并定期撤销失效授权。',
    defensive_signals_zh: ['安装或运行步骤要求导出浏览器资料、会话信息或永久访问凭据。', '工具用途与其要求读取的账号、客户或支付数据范围不相称。']
  },
  {
    key: 'advertising_integrity',
    terms: ['ad review bypass', 'misleading claims', 'fake engagement', 'click fraud'],
    category_zh: '广告审核、内容真实性与互动完整性风险',
    risk_zh: '可能导致广告拒登、停投、账户处罚或消费者误导。',
    safe_alternative_zh: '广告文案、素材、落地页和商品声明均以 Meta 广告标准及实际可验证证据复核；不伪造评价、互动、折扣或功效。',
    defensive_signals_zh: ['功效、优惠、库存、评价或互动无法由真实证据支持。', '广告素材、落地页、商品资料三者的声明不一致。']
  },
  {
    key: 'privacy_and_data_governance',
    terms: ['consent bypass', 'data exfiltration', 'pii scraper', 'customer list leak'],
    category_zh: '隐私、同意与客户数据治理风险',
    risk_zh: '可能违反隐私承诺、平台条款或数据保护法律，并损害客户权益。',
    safe_alternative_zh: '先取得适用的同意与合法依据；最小化收集；遵守退订、删除和数据访问请求；只用官方或获授权接口。',
    defensive_signals_zh: ['Pixel、CAPI、受众或客户名单没有同意记录、用途说明或删除机制。', '数据流向无法说明收集目的、最小化范围与处理责任方。']
  },
  {
    key: 'product_and_consumer_safety',
    terms: ['unsafe product', 'prohibited product', 'counterfeit product'],
    category_zh: '商品、消费者安全与受限品类风险',
    risk_zh: '可能引发下架、退款、召回、监管处罚或消费者伤害。',
    safe_alternative_zh: '上架前完成商品身份、合规标签、警示、运输限制、目标国规则和供应链证据检查。',
    defensive_signals_zh: ['商品身份、责任主体、标签警示、运输限制或目标国资料缺失。', '来源、检测、召回和售后资料相互矛盾或无法验证。']
  },
  {
    key: 'intellectual_property_and_content_rights',
    terms: ['trademark infringement', 'brand impersonation', 'watermark removal', 'drm cracking'],
    category_zh: '商标、版权与素材权利风险',
    risk_zh: '可能造成投诉、下架、账户限制、赔偿或纠纷。',
    safe_alternative_zh: '只使用已验证授权的商品、商标和图片视频；保留许可、署名和授权范围证据。',
    defensive_signals_zh: ['素材、品牌、人物形象或音乐没有商业许可范围与来源证据。', '项目卖点是移除权利标识、冒用品牌或复制他人内容。']
  },
  {
    key: 'measurement_integrity',
    terms: ['fake conversion', 'event spoofing', 'metric manipulation'],
    category_zh: '追踪、归因与指标真实性风险',
    risk_zh: '会误导优化决策、破坏平台信号质量，并可能违反平台或合同要求。',
    safe_alternative_zh: '只发送真实业务事件；使用官方 Pixel/CAPI 去重、同意和数据质量规则，并以订单、退款和支付记录复核。',
    defensive_signals_zh: ['事件量、订单、支付、退款与库存无法对账。', '工具要求制造、重复或修改业务事件，而不是修复真实采集链路。']
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

function metadataEvidenceProfile(repo, quality) {
  const checks = [
    { key: 'license', ok: quality.license && quality.license !== 'NOASSERTION', label_zh: '许可证' },
    { key: 'description', ok: String(repo.description ?? '').trim().length >= 40, label_zh: '足够的公开简介' },
    { key: 'language', ok: Boolean(repo.language), label_zh: '主要语言' },
    { key: 'topics', ok: (repo.topics ?? []).length >= 2, label_zh: '主题标签' },
    { key: 'branch', ok: Boolean(repo.default_branch), label_zh: '默认分支' },
    { key: 'timestamps', ok: Boolean(repo.updated_at) && Boolean(repo.pushed_at), label_zh: '更新时间和推送时间' }
  ];
  const passed = checks.filter((item) => item.ok);
  const score = Math.round((passed.length / checks.length) * 100) / 100;
  const label = score >= 0.84 ? '公开元数据较完整' : score >= 0.5 ? '公开元数据部分完整' : '公开元数据不足';
  return {
    score,
    label_zh: label,
    verified_fields_zh: passed.map((item) => item.label_zh),
    missing_fields_zh: checks.filter((item) => !item.ok).map((item) => item.label_zh),
    note_zh: '只衡量本次公开元数据是否足以支持初步研究；不代表代码安全、功能真实、供应商可靠或可以接入真实账户。'
  };
}

function communitySignalProfile(repo, now = new Date()) {
  const stars = Number(repo.stargazers_count ?? 0);
  const forks = Number(repo.forks_count ?? 0);
  const projectAgeDays = Math.floor(daysSince(repo.created_at, now));
  let label = '公开社区信号未形成';
  if (stars >= 20 || forks >= 5) label = '已有基础公开社区信号';
  else if (stars >= 3 || forks >= 1) label = '已有有限公开社区信号';
  return {
    stars,
    forks,
    project_age_days: Number.isFinite(projectAgeDays) ? projectAgeDays : null,
    label_zh: label,
    note_zh: '仅按公开星标、Fork 和项目年龄提示社区信号；不代表安全、可信、合规、效果或适合接入。'
  };
}

const CAPABILITY_EXPOSURE_RULES = [
  {
    id: 'potential_external_write',
    pattern: /\b(?:post(?:ing)?|publish(?:ing)?|schedule|scheduling|drafts?|comment(?:s|ing)?|comment management|page management)\b/i,
    label_zh: '公开元数据提示可能具有对外发布、排程或评论管理能力',
    review_zh: '若后续评估，先逐项确认是否会发布、排程、创建草稿或管理评论；未获得单次书面授权不得连接真实主页。'
  },
  {
    id: 'browser_automation',
    pattern: /\b(?:playwright|puppeteer|selenium|browser automation)\b/i,
    label_zh: '公开元数据提示可能包含浏览器自动化',
    review_zh: '先确认数据源是否允许自动化访问；不得登录私人后台、绕过验证码或规避平台限制。'
  },
  {
    id: 'agent_or_mcp_integration',
    pattern: /\b(?:mcp|agents?|agentic)\b/i,
    label_zh: '公开元数据提示可能与 Agent 或 MCP 工具连接有关',
    review_zh: '先检查工具清单、外部网络请求、权限范围和日志；不得提供 Token、Cookie、客户资料或真实广告写入权限。'
  },
  {
    id: 'official_api_scope_review',
    pattern: /\b(?:graph api|facebook api|meta api|shopify api)\b/i,
    label_zh: '公开元数据提及平台 API',
    review_zh: '以当日 Meta/Shopify 官方权限与数据范围说明为准，逐项核对读写范围和最小权限。'
  }
];

function capabilityExposureProfile(repo, quality) {
  const text = [relevanceText(repo), ...quality.topics].join(' ');
  const exposures = CAPABILITY_EXPOSURE_RULES.filter((item) => item.pattern.test(text)).map((item) => ({
    id: item.id,
    label_zh: item.label_zh,
    review_zh: item.review_zh
  }));
  return exposures;
}

function manualReviewRequirements(repo, evidence, exposures) {
  const requirements = [
    '阅读项目公开说明、许可证和依赖清单，确认实际用途与本次公开元数据一致。',
    '在隔离环境完成最小化只读评估；不得在评估前接入真实 Meta、Shopify、客户或支付数据。',
    '核对数据流、日志位置、网络访问和权限范围；不得提供 Token、Cookie、恢复资料或客户名单。'
  ];
  if (evidence.score < 0.84) requirements.push(`补齐或人工核对：${evidence.missing_fields_zh.join('、')}。`);
  for (const exposure of exposures) requirements.push(exposure.review_zh);
  if (String(repo.description ?? '').trim().length < 40) requirements.push('项目公开简介过短，不能据此推断能力、数据源、成本、隐私或合规性。');
  return [...new Set(requirements)];
}

function compactRepository(repo, quality, query, provider = 'GitHub') {
  const evidence = metadataEvidenceProfile(repo, quality);
  const exposures = capabilityExposureProfile(repo, quality);
  const communitySignal = communitySignalProfile(repo);
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
    created_at: repo.created_at ?? null,
    project_age_days: communitySignal.project_age_days,
    pushed_at: repo.pushed_at ?? null,
    updated_at: repo.updated_at ?? null,
    age_days: quality.age_days,
    freshness: quality.freshness,
    freshness_label_zh: quality.freshness === 'fresh_within_30_days' ? '最近 30 天更新：新技术候选' : `超过一个月、半年内：最后更新距今 ${quality.age_days} 天`,
    quality_score: quality.score,
    discovery_priority_score: quality.score,
    discovery_priority_note_zh: '发现排序分只用于从公开元数据中排定人工研究先后；不代表安全、代码质量、功能真实性、盈利能力或可直接采用。',
    metadata_evidence_score: evidence.score,
    metadata_evidence_label_zh: evidence.label_zh,
    metadata_verified_fields_zh: evidence.verified_fields_zh,
    metadata_missing_fields_zh: evidence.missing_fields_zh,
    metadata_evidence_note_zh: evidence.note_zh,
    public_community_signal_label_zh: communitySignal.label_zh,
    public_community_signal_note_zh: communitySignal.note_zh,
    selection_reasons_zh: quality.reasons,
    discovery_query: query,
    discovery_queries: [query],
    discovery_providers: [provider],
    matching_query_count: 1,
    capability_exposures: exposures,
    automatic_adoption_allowed: false,
    research_status: 'research_only',
    research_status_zh: '仅限公开元数据研究；尚未安装、执行、审计或授权接入。',
    manual_review_requirements_zh: manualReviewRequirements(repo, evidence, exposures),
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
      defensive_signals_zh: item.defensive_signals_zh,
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

export async function buildResearchSourceLedger({
  catalog = null,
  frontier = null,
  riskRegistry = null,
  catalogPath = COMMUNITY_CATALOG_PATH,
  frontierCatalogPath = FRONTIER_CATALOG_PATH,
  riskRegistryPath = COMPLIANCE_RISK_REGISTRY_PATH,
  ledgerPath = RESEARCH_SOURCE_LEDGER_PATH,
  now = new Date()
} = {}) {
  const mainCatalog = catalog ?? await readJson(catalogPath);
  const frontierCatalog = frontier ?? (await exists(frontierCatalogPath) ? await readJson(frontierCatalogPath) : { repositories: [] });
  const risks = riskRegistry ?? (await exists(riskRegistryPath) ? await readJson(riskRegistryPath) : { official_evidence: [] });
  const sources = new Map();
  for (const item of [...(mainCatalog.repositories ?? []), ...(frontierCatalog.repositories ?? [])]) {
    const url = String(item.canonical_url ?? '');
    if (!/^https:\/\/(github\.com|gitlab\.com)\//i.test(url)) continue;
    sources.set(url, {
      source_id: item.source_id,
      source_class_zh: '合规开源技术候选公开元数据',
      title_zh: item.title_zh ?? item.repository,
      provider: item.provider ?? 'unknown',
      url,
      updated_at: item.updated_at ?? null,
      freshness: item.freshness ?? 'unknown'
    });
  }
  for (const item of risks.official_evidence ?? []) {
    const url = String(item.url ?? '');
    if (!/^https:\/\/(?:[\w.-]*facebook\.com|[\w.-]*meta\.com|[\w.-]*shopify\.com)\//i.test(url)) continue;
    sources.set(url, {
      source_id: `official-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
      source_class_zh: '官方合规与防范依据',
      title_zh: item.title_zh ?? '官方规则来源',
      provider: item.publisher ?? 'official',
      url,
      updated_at: null,
      freshness: 'official_reference'
    });
  }
  const entries = [...sources.values()].sort((a, b) => a.source_class_zh.localeCompare(b.source_class_zh) || a.title_zh.localeCompare(b.title_zh));
  const ledger = {
    schema_version: 1,
    source_tier: 'research_source_ledger',
    generated_at: isoTaipei(now),
    purpose_zh: '保存可安全研究的公开来源链接，支持技术核验、合规防范与回溯。',
    source_count: entries.length,
    source_scope_zh: '仅包含合规开源候选的 GitHub/GitLab 公开链接，以及 Meta/Shopify 官方规则与安全依据链接。',
    excluded_scope_zh: '不保存可直接定位、下载或复用违规项目的链接、代码、账号规避步骤、Cookie、Token、凭据或绕过方法。',
    sources: entries
  };
  await writeJsonAtomic(ledgerPath, ledger);
  return { ledger, ledgerPath };
}

function markdownInline(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]<>|])/g, '\\$1').trim();
}

function markdownRepositoryLink(repository, url) {
  const label = markdownInline(repository || '未命名仓库');
  return /^https:\/\/(?:github|gitlab)\.com\//i.test(String(url ?? '')) ? `[${label}](${url})` : label;
}

function coverageSummary(catalog) {
  const coverage = catalog.query_coverage ?? {};
  const successful = Number(coverage.successful_queries ?? catalog.searched_queries ?? 0);
  const legacyGaps = catalog.warnings ?? [];
  const gaps = Array.isArray(coverage.gaps) ? coverage.gaps : legacyGaps;
  const failed = Number(coverage.failed_queries ?? (coverage.attempted_queries == null ? gaps.length : 0));
  const attempted = Number(coverage.attempted_queries ?? (successful + failed));
  const providerStatistics = Object.values(coverage.provider_statistics ?? {});
  return { attempted, successful, failed, providerStatistics, gaps, status: coverage.coverage_status_zh ?? '旧版目录未记录完整查询覆盖信息。' };
}

export async function buildCommunityResearchReport({
  catalog = null,
  riskRegistry = null,
  catalogPath = COMMUNITY_CATALOG_PATH,
  riskRegistryPath = COMPLIANCE_RISK_REGISTRY_PATH,
  reportPath = COMMUNITY_RESEARCH_REPORT_PATH,
  now = new Date()
} = {}) {
  const source = catalog ?? await readJson(catalogPath);
  const risks = riskRegistry ?? (await exists(riskRegistryPath) ? await readJson(riskRegistryPath) : null);
  const coverage = coverageSummary(source);
  const repositories = source.repositories ?? [];
  const lines = [
    '# GitHub / GitLab 公开技术雷达：最新研究报告',
    '',
    `- 生成时间：${source.generated_at ?? isoTaipei(now)}（Asia/Taipei）`,
    `- 数据范围：${source.scope_zh ?? '仅公开仓库元数据'}`,
    '- 数据边界：只读取公开仓库元数据；不克隆、不安装、不执行第三方代码；不读取或提供 Token、Cookie、账号资料、客户资料或真实 Meta / Shopify 数据。',
    '- 研究状态：下列全部是“仅研究候选”，不是已安装、已启用、已审计或已批准采用的工具。',
    '',
    '## 采集覆盖',
    '',
    `- 计划查询：${coverage.attempted} 条；成功：${coverage.successful} 条；未完成：${coverage.failed} 条。`,
    `- 结论：${coverage.status}`,
    `- 入选候选：${repositories.length} 个。`,
    ''
  ];
  if (coverage.providerStatistics.length) {
    lines.push('| 平台 | 计划 | 成功 | 未完成 | 限额等待 | 返回的公开元数据条目 | 合格候选命中（含重复） |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const item of coverage.providerStatistics) lines.push(`| ${markdownInline(item.provider)} | ${Number(item.attempted_queries ?? 0)} | ${Number(item.successful_queries ?? 0)} | ${Number(item.failed_queries ?? 0)} | ${Number(item.rate_limit_wait_seconds ?? 0)} 秒 | ${Number(item.returned_repository_metadata ?? 0)} | ${Number(item.qualifying_candidate_observations ?? 0)} |`);
    lines.push('');
  }
  const efficiency = source.discovery_efficiency;
  if (efficiency) {
    lines.push('### 筛选效率与边界', '');
    lines.push(`- 本轮累计读取公开元数据 ${Number(efficiency.returned_repository_metadata ?? 0)} 条（跨查询可能重复）；硬性拒绝 ${Number(efficiency.hard_rejected_observations ?? 0)} 条；低于研究排序门槛 ${Number(efficiency.below_minimum_quality_observations ?? 0)} 条；进入风险隔离 ${Number(efficiency.risk_isolated_observations ?? 0)} 条；最终唯一候选 ${Number(efficiency.unique_candidate_count ?? repositories.length)} 个。`);
    lines.push(`- 说明：${markdownInline(efficiency.note_zh ?? '')}`, '');
  }
  if (coverage.gaps.length) {
    lines.push('### 覆盖缺口（不绕过）', '');
    for (const gap of coverage.gaps) {
      const providerMessage = gap.provider_message ? `平台说明：${markdownInline(gap.provider_message)}。` : '';
      lines.push(`- ${markdownInline(gap.provider)}：查询“${markdownInline(gap.query)}”未完成（${markdownInline(gap.error)}）。${providerMessage}${markdownInline(gap.handling_zh ?? '等待下次正常计划任务再试。')}`);
    }
    lines.push('');
  }
  lines.push('## 候选逐项说明', '');
  if (!repositories.length) {
    lines.push('本轮没有通过硬性筛选的候选。没有候选不代表没有相关技术，只表示当前公开查询和筛选条件下未形成可研究候选。', '');
  }
  for (let index = 0; index < repositories.length; index += 1) {
    const item = repositories[index];
    const profileRepo = {
      full_name: item.repository,
      description: item.description_original,
      topics: item.topics ?? [],
      language: item.language,
      default_branch: item.default_branch,
      created_at: item.created_at,
      updated_at: item.updated_at,
      pushed_at: item.pushed_at,
      stargazers_count: item.stars,
      forks_count: item.forks
    };
    const profileQuality = { license: item.license_spdx, topics: item.topics ?? [] };
    const computedEvidence = metadataEvidenceProfile(profileRepo, profileQuality);
    const evidence = item.metadata_evidence_score == null ? computedEvidence : {
      score: item.metadata_evidence_score,
      label_zh: item.metadata_evidence_label_zh,
      missing_fields_zh: item.metadata_missing_fields_zh ?? []
    };
    const exposures = item.capability_exposures ?? capabilityExposureProfile(profileRepo, profileQuality);
    const communitySignal = item.public_community_signal_label_zh ? {
      label_zh: item.public_community_signal_label_zh,
      note_zh: item.public_community_signal_note_zh
    } : communitySignalProfile(profileRepo);
    const exposureLabels = exposures.map((exposure) => exposure.label_zh);
    const reviewRequirements = item.manual_review_requirements_zh ?? manualReviewRequirements(profileRepo, evidence, exposures);
    lines.push(`### ${index + 1}. ${markdownRepositoryLink(item.repository, item.canonical_url)}`, '');
    lines.push(`- 公开简介：${markdownInline(item.description_original || '未提供；不能据此推断具体能力。')}`);
    lines.push(`- 元数据：许可证 ${markdownInline(item.license_spdx)}；语言 ${markdownInline(item.language || '未标注')}；最近更新 ${markdownInline(item.updated_at || '未知')}；星标 / Fork ${Number(item.stars ?? 0)} / ${Number(item.forks ?? 0)}。`);
    lines.push(`- 发现排序：${Number(item.discovery_priority_score ?? item.quality_score ?? 0)} 分。${markdownInline(item.discovery_priority_note_zh ?? '旧版目录的分数只适用于发现排序，不代表可采用。')}`);
    lines.push(`- 证据完整度：${Number(evidence.score * 100).toFixed(0)}%（${markdownInline(evidence.label_zh)}）。`);
    lines.push(`- 公开社区信号：${markdownInline(communitySignal.label_zh)}。${markdownInline(communitySignal.note_zh)}`);
    lines.push(`- 命中来源：${Number(item.matching_query_count ?? (item.discovery_queries ?? [item.discovery_query]).filter(Boolean).length)} 条查询；${markdownInline((item.discovery_providers ?? [item.provider]).filter(Boolean).join('、') || '未记录')}。`);
    lines.push(`- 公开元数据提示的能力暴露：${exposureLabels.length ? exposureLabels.map(markdownInline).join('；') : '未命中预设暴露信号；这不等于没有风险或外部连接能力。'}`);
    lines.push(`- 当前状态：${markdownInline(item.research_status_zh ?? '仅元数据候选；未安装、未审计、未授权接入。')}`);
    lines.push('- 人工复核：');
    for (const requirement of reviewRequirements) lines.push(`  - ${markdownInline(requirement)}`);
    lines.push('');
  }
  lines.push('## 合规隔离与正确使用', '');
  lines.push(`- 本轮匿名合规风险命中：${Number(risks?.observed_candidate_count ?? 0)}。风险隔离库只保存类别和匿名计数，不保存违规项目链接、代码、凭据或规避方法。`);
  lines.push('- 判断平台规则、权限和数据边界时，以 Meta / Shopify 官方资料为准；第三方项目只能提供待核验的技术线索。');
  lines.push('- 如需评估任何候选，先在隔离环境进行最小化只读审计，完成数据流和权限检查后，再决定是否值得继续；不得直接连接真实业务资产。', '');
  await writeTextAtomic(reportPath, `${lines.join('\n')}\n`);
  return { reportPath, repositoryCount: repositories.length, coverage };
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
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Hermes-Open-Source-Radar/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchPublicMetadata(url, { headers, timeoutMs: 25_000 }, fetchImpl, 'GitHub');
  const payload = await response.json();
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    items,
    telemetry: {
      returned_repository_metadata: items.length,
      reported_total_count: Number.isFinite(Number(payload.total_count)) ? Number(payload.total_count) : null,
      incomplete_results: Boolean(payload.incomplete_results),
      response: responseDiagnostics(response)
    }
  };
}

function normalizeGitLabRepository(project) {
  return {
    provider_project_id: project.id ?? null,
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
    open_issues_count: Number(project.open_issues_count ?? 0),
    created_at: project.created_at ?? null,
    pushed_at: project.last_activity_at ?? project.updated_at ?? null,
    updated_at: project.updated_at ?? project.last_activity_at ?? null,
    default_branch: project.default_branch ?? null,
    language: null
  };
}

function shouldEnrichGitLabLicense(repo, { maximumAgeDays = 180, unsafeTerms = [] } = {}) {
  if (repo.archived || repo.fork || repo.disabled) return false;
  const text = relevanceText(repo);
  if (isUnsafeRepository(text, unsafeTerms)) return false;
  if (!isMetaPlatformRelevant(text) && !isShopifyPlatformRelevant(text)) return false;
  const ageDays = daysSince(repo.updated_at);
  return Number.isFinite(ageDays) && ageDays <= Number(maximumAgeDays ?? 180);
}

async function gitlabSearch(query, { fetchImpl = fetch, perPage = 40, detailCache = new Map(), providerConfig = {}, unsafeTerms = [] } = {}) {
  const url = new URL(GITLAB_API);
  url.searchParams.set('search', query);
  url.searchParams.set('visibility', 'public');
  url.searchParams.set('order_by', 'updated_at');
  url.searchParams.set('sort', 'desc');
  url.searchParams.set('per_page', String(Math.min(100, Math.max(1, perPage))));
  const headers = { Accept: 'application/json', 'User-Agent': 'Hermes-Open-Source-Radar/1.0' };
  const response = await fetchPublicMetadata(url, { headers, timeoutMs: 25_000 }, fetchImpl, 'GitLab');
  const payload = await response.json();
  const items = Array.isArray(payload) ? payload.map(normalizeGitLabRepository) : [];
  const enrichment = {
    eligible_projects: 0,
    detail_requests: 0,
    cache_hits: 0,
    resolved_projects: 0,
    not_found_projects: 0,
    failed_projects: 0
  };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!shouldEnrichGitLabLicense(item, { maximumAgeDays: providerConfig.maximum_age_days, unsafeTerms })) continue;
    enrichment.eligible_projects += 1;
    const projectId = item.provider_project_id;
    if (projectId == null) {
      enrichment.failed_projects += 1;
      continue;
    }
    const cacheKey = String(projectId);
    let detailPromise = detailCache.get(cacheKey);
    if (!detailPromise) {
      const detailUrl = new URL(`${GITLAB_API}/${encodeURIComponent(cacheKey)}`);
      detailUrl.searchParams.set('license', 'true');
      detailPromise = (async () => {
        const detailResponse = await fetchPublicMetadata(detailUrl, { headers, timeoutMs: 25_000 }, fetchImpl, 'GitLab');
        return detailResponse.json();
      })();
      detailCache.set(cacheKey, detailPromise);
      enrichment.detail_requests += 1;
    } else {
      enrichment.cache_hits += 1;
    }
    try {
      const detail = await detailPromise;
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('GitLab 项目详情格式无效');
      items[index] = { ...item, ...normalizeGitLabRepository(detail) };
      enrichment.resolved_projects += 1;
    } catch (error) {
      if (httpStatusFromError(error) === 404) enrichment.not_found_projects += 1;
      else enrichment.failed_projects += 1;
    }
  }
  return {
    items,
    telemetry: {
      returned_repository_metadata: items.length,
      reported_total_count: numericHeader(response.headers, 'x-total'),
      incomplete_results: enrichment.failed_projects > 0,
      license_enrichment: enrichment,
      response: responseDiagnostics(response)
    }
  };
}

function numericHeader(headers, name) {
  const value = headers?.get(name);
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function responseDiagnostics(response) {
  return {
    http_status: response.status,
    request_id: response.headers.get('x-github-request-id') ?? response.headers.get('x-request-id') ?? null,
    retry_after_seconds: numericHeader(response.headers, 'retry-after'),
    rate_limit: {
      limit: numericHeader(response.headers, 'x-ratelimit-limit'),
      remaining: numericHeader(response.headers, 'x-ratelimit-remaining'),
      reset_epoch_seconds: numericHeader(response.headers, 'x-ratelimit-reset'),
      resource: response.headers.get('x-ratelimit-resource') ?? null
    }
  };
}

function sanitizeProviderMessage(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/[^\s\/@:]+:[^\s\/@]+@/gi, 'https://[凭据已省略]@')
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{12,}\b/g, '[凭据已省略]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[服务端地址已省略]')
    .replace(/\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi, '[服务端地址已省略]')
    .replace(/((?:access[_-]?token|token|authorization|cookie|secret)\s*[:=]\s*)([^,;\s]+)/gi, '$1[已省略]')
    .trim()
    .slice(0, 280);
}

async function providerErrorMessage(response) {
  try {
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('json') ? await response.json() : null;
    const message = typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : '';
    return sanitizeProviderMessage(message) || null;
  } catch {
    return null;
  }
}

function httpStatusFromError(error) {
  const status = Number(error?.http_status ?? String(error?.message ?? '').match(/HTTP\s+(\d{3})/)?.[1]);
  return Number.isInteger(status) ? status : null;
}

function queryFailureProfile(error) {
  const httpStatus = httpStatusFromError(error);
  const response = error?.response_diagnostics ?? null;
  const rate = response?.rate_limit ?? {};
  const isPrimaryRateLimited = rate.remaining === 0;
  const isSecondaryRateLimited = Number(response?.retry_after_seconds) > 0 || /secondary rate limit/i.test(String(error?.provider_message ?? ''));
  if (httpStatus === 403 && isPrimaryRateLimited) return {
    http_status: httpStatus,
    failure_kind: 'primary_rate_limited',
    handling_zh: '已停止该查询；GitHub 限额归零，将等待 x-ratelimit-reset 指定时间后由下次计划任务再试。'
  };
  if ((httpStatus === 403 || httpStatus === 429) && isSecondaryRateLimited) return {
    http_status: httpStatus,
    failure_kind: 'secondary_rate_limited',
    handling_zh: '已停止该查询；将遵守 Retry-After 或至少等待下一次计划任务，不增加并发或绕过限制。'
  };
  if (httpStatus === 401 || httpStatus === 403) return {
    http_status: httpStatus,
    failure_kind: 'access_or_permission_limited',
    handling_zh: '已停止该查询；不会绕过访问限制或改用其他身份。等待下次使用正常公开权限的计划任务再试。'
  };
  if (httpStatus === 429) return {
    http_status: httpStatus,
    failure_kind: 'rate_limited',
    handling_zh: '已停止该查询；保留已取得结果，不进行高频重试，等待下次计划任务。'
  };
  if (httpStatus && httpStatus >= 500) return {
    http_status: httpStatus,
    failure_kind: 'provider_temporary_error',
    handling_zh: '已按普通临时错误最多重试两次；仍失败则保留覆盖缺口，等待下次计划任务。'
  };
  return {
    http_status: httpStatus,
    failure_kind: 'network_or_unknown_error',
    handling_zh: '保留覆盖缺口；下次计划任务会重新尝试，不会用绕过方式补取。'
  };
}

async function fetchPublicMetadata(url, options = {}, fetchImpl, provider) {
  let lastError = null;
  const { timeoutMs = 25_000, signal: providedSignal, ...requestOptions } = options;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const attemptOptions = { ...requestOptions };
      if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) attemptOptions.signal = AbortSignal.timeout(Number(timeoutMs));
      else if (providedSignal) attemptOptions.signal = providedSignal;
      const response = await fetchImpl(url, attemptOptions);
      if (response.ok) return response;
      const retryable = response.status >= 500 && response.status <= 599;
      if (!retryable || attempt === 2) {
        const error = new Error(`${provider} 公开仓库搜索失败：HTTP ${response.status}`);
        error.http_status = response.status;
        error.attempt_count = attempt + 1;
        error.response_diagnostics = responseDiagnostics(response);
        error.provider_message = await providerErrorMessage(response);
        throw error;
      }
      lastError = new Error(`${provider} 公开仓库搜索失败：HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      const httpStatus = httpStatusFromError(error);
      const retryable = !httpStatus || (httpStatus >= 500 && httpStatus <= 599);
      if (!retryable || attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw lastError ?? new Error(`${provider} 公开仓库搜索失败。`);
}

function coverageGate(config, attemptedQueries, successfulQueries, incompleteQueryCount = 0) {
  const configured = Number(config.safety?.minimum_query_success_ratio ?? 1);
  const minimumSuccessRatio = Number.isFinite(configured) && configured > 0 && configured <= 1 ? configured : 1;
  const actualSuccessRatio = attemptedQueries > 0 ? Math.round((successfulQueries / attemptedQueries) * 10_000) / 10_000 : 0;
  return {
    minimum_success_ratio: minimumSuccessRatio,
    actual_success_ratio: actualSuccessRatio,
    incomplete_query_count: incompleteQueryCount,
    publication_eligible: actualSuccessRatio >= minimumSuccessRatio && incompleteQueryCount === 0,
    rule_zh: `至少完成 ${(minimumSuccessRatio * 100).toFixed(0)}% 的计划公开查询，且没有平台标记的不完整结果，才允许用新目录替换上一份合格目录或公开发布。`
  };
}

function mergeCandidateProvenance(existing, candidate) {
  if (!existing) return candidate;
  const selected = candidate.quality_score > existing.quality_score ? candidate : existing;
  const discoveryQueries = [...new Set([...(existing.discovery_queries ?? [existing.discovery_query]), ...(candidate.discovery_queries ?? [candidate.discovery_query])])].filter(Boolean);
  const discoveryProviders = [...new Set([...(existing.discovery_providers ?? [existing.provider]), ...(candidate.discovery_providers ?? [candidate.provider])])].filter(Boolean);
  return {
    ...selected,
    discovery_queries: discoveryQueries,
    discovery_providers: discoveryProviders,
    matching_query_count: discoveryQueries.length
  };
}

function maximumRateLimitWaitSeconds(providerConfig = {}) {
  const value = Number(providerConfig.max_rate_limit_wait_seconds ?? 75);
  return Number.isFinite(value) && value >= 1 && value <= 300 ? Math.floor(value) : 75;
}

async function waitForRateLimitReset(provider, providerConfig, rateResetTimes) {
  const resetAt = Number(rateResetTimes.get(provider) ?? 0);
  if (!Number.isFinite(resetAt) || resetAt <= Date.now()) return { waited_seconds: 0, deferred: false };
  const waitMilliseconds = resetAt - Date.now() + 1_000;
  const waitSeconds = Math.ceil(waitMilliseconds / 1_000);
  if (waitSeconds > maximumRateLimitWaitSeconds(providerConfig)) {
    return { waited_seconds: 0, deferred: true, reset_epoch_seconds: Math.floor(resetAt / 1_000) };
  }
  await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
  rateResetTimes.delete(provider);
  return { waited_seconds: waitSeconds, deferred: false, reset_epoch_seconds: Math.floor(resetAt / 1_000) };
}

export async function discoverOpenSourceTechnology({
  configPath = COMMUNITY_CONFIG_PATH,
  catalogPath = COMMUNITY_CATALOG_PATH,
  frontierCatalogPath = path.join(path.dirname(catalogPath), 'frontier', 'latest-30-days.json'),
  riskRegistryPath = path.join(path.dirname(catalogPath), 'compliance-risk', 'isolated-risk-registry.json'),
  sourceLedgerPath = path.join(path.dirname(catalogPath), 'research-sources', 'source-ledger.json'),
  reportPath = null,
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
  const providerStatistics = {};
  const rateResetTimes = new Map();
  const gitlabDetailCache = new Map();
  const queryRuns = [];
  const filterSummary = {
    returned_repository_metadata: 0,
    hard_rejected_observations: 0,
    below_minimum_quality_observations: 0,
    risk_isolated_observations: 0,
    qualifying_candidate_observations: 0
  };
  const candidates = new Map();
  const riskObservations = new Map();
  const observedRiskSources = new Map();
  let searched = 0;
  let attempted = 0;
  function statisticsFor(provider) {
    const key = provider.toLowerCase();
    providerStatistics[key] ??= {
      provider,
      attempted_queries: 0,
      successful_queries: 0,
      failed_queries: 0,
      returned_repository_metadata: 0,
      reported_total_count_sum: 0,
      incomplete_query_count: 0,
      hard_rejected_observations: 0,
      below_minimum_quality_observations: 0,
      risk_isolated_observations: 0,
      qualifying_candidate_observations: 0,
      rate_limit_wait_seconds: 0,
      rate_limit_deferred_queries: 0,
      license_enrichment_eligible_projects: 0,
      license_detail_requests: 0,
      license_detail_cache_hits: 0,
      license_detail_resolved_projects: 0,
      license_detail_not_found_projects: 0,
      license_detail_failed_projects: 0
    };
    return providerStatistics[key];
  }
  async function collect(provider, query, search, providerConfig) {
    attempted += 1;
    const statistics = statisticsFor(provider);
    statistics.attempted_queries += 1;
    const rateWait = await waitForRateLimitReset(provider, providerConfig, rateResetTimes);
    statistics.rate_limit_wait_seconds += rateWait.waited_seconds;
    if (rateWait.deferred) {
      statistics.failed_queries += 1;
      statistics.rate_limit_deferred_queries += 1;
      const warning = {
        provider,
        query,
        error: '为遵守公开 API 限额而延后查询',
        provider_message: null,
        response: { http_status: null, request_id: null, retry_after_seconds: null, rate_limit: { limit: null, remaining: 0, reset_epoch_seconds: rateWait.reset_epoch_seconds, resource: 'search' } },
        http_status: null,
        failure_kind: 'rate_limit_reset_deferred',
        handling_zh: '已在不超过允许等待时间的前提下停止本轮；等待下次计划任务在额度重置后再试。'
      };
      warnings.push(warning);
      queryRuns.push({ provider, query, outcome: 'deferred', rate_limit_wait_seconds: 0, ...warning });
      return;
    }
    try {
      const searchResult = await search(query, {
        fetchImpl,
        token,
        perPage: providerConfig.max_results_per_query,
        providerConfig,
        unsafeTerms: config.safety?.excluded_terms ?? [],
        detailCache: gitlabDetailCache
      });
      const items = Array.isArray(searchResult) ? searchResult : (searchResult.items ?? []);
      const telemetry = Array.isArray(searchResult) ? {} : (searchResult.telemetry ?? {});
      searched += 1;
      statistics.successful_queries += 1;
      statistics.returned_repository_metadata += items.length;
      statistics.reported_total_count_sum += Number(telemetry.reported_total_count ?? 0);
      if (telemetry.incomplete_results) statistics.incomplete_query_count += 1;
      const licenseEnrichment = telemetry.license_enrichment ?? {};
      statistics.license_enrichment_eligible_projects += Number(licenseEnrichment.eligible_projects ?? 0);
      statistics.license_detail_requests += Number(licenseEnrichment.detail_requests ?? 0);
      statistics.license_detail_cache_hits += Number(licenseEnrichment.cache_hits ?? 0);
      statistics.license_detail_resolved_projects += Number(licenseEnrichment.resolved_projects ?? 0);
      statistics.license_detail_not_found_projects += Number(licenseEnrichment.not_found_projects ?? 0);
      statistics.license_detail_failed_projects += Number(licenseEnrichment.failed_projects ?? 0);
      filterSummary.returned_repository_metadata += items.length;
      const queryRun = {
        provider,
        query,
        outcome: 'completed',
        returned_repository_metadata: items.length,
        reported_total_count: telemetry.reported_total_count ?? null,
        incomplete_results: Boolean(telemetry.incomplete_results),
        license_enrichment: telemetry.license_enrichment ?? null,
        response: telemetry.response ?? null,
        rate_limit_wait_seconds: rateWait.waited_seconds,
        hard_rejected_observations: 0,
        below_minimum_quality_observations: 0,
        risk_isolated_observations: 0,
        qualifying_candidate_observations: 0
      };
      for (const repo of items) {
        const quality = scoreOpenSourceRepository(repo, {
          allowedLicenses: providerConfig.allowed_licenses,
          freshWithinDays: Number(providerConfig.fresh_within_days ?? 30),
          maximumAgeDays: Number(providerConfig.maximum_age_days ?? 180),
          unsafeTerms: config.safety?.excluded_terms ?? [],
          now
        });
        if (quality.risk_category_key) {
          queryRun.risk_isolated_observations += 1;
          statistics.risk_isolated_observations += 1;
          filterSummary.risk_isolated_observations += 1;
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
        if (quality.score < Number(providerConfig.minimum_quality_score ?? 7)) {
          if (quality.score < 0) {
            queryRun.hard_rejected_observations += 1;
            statistics.hard_rejected_observations += 1;
            filterSummary.hard_rejected_observations += 1;
          } else {
            queryRun.below_minimum_quality_observations += 1;
            statistics.below_minimum_quality_observations += 1;
            filterSummary.below_minimum_quality_observations += 1;
          }
          continue;
        }
        queryRun.qualifying_candidate_observations += 1;
        statistics.qualifying_candidate_observations += 1;
        filterSummary.qualifying_candidate_observations += 1;
        const card = compactRepository(repo, quality, query, provider);
        const existing = candidates.get(card.source_id);
        candidates.set(card.source_id, mergeCandidateProvenance(existing, card));
      }
      const resetEpoch = Number(telemetry.response?.rate_limit?.reset_epoch_seconds ?? 0);
      if (telemetry.response?.rate_limit?.remaining === 0 && Number.isFinite(resetEpoch) && resetEpoch > 0) {
        rateResetTimes.set(provider, resetEpoch * 1_000);
      }
      queryRuns.push(queryRun);
    } catch (error) {
      statistics.failed_queries += 1;
      const failure = queryFailureProfile(error);
      const warning = {
        provider,
        query,
        error: error.message,
        provider_message: error.provider_message ?? null,
        response: error.response_diagnostics ?? null,
        ...failure
      };
      warnings.push(warning);
      queryRuns.push({ provider, query, outcome: 'failed', ...warning });
    }
  }
  if (config.providers?.includes('github') !== false) for (const query of config.github.queries) await collect('GitHub', query, githubSearch, config.github);
  if (config.providers?.includes('gitlab') && config.gitlab) for (const query of config.gitlab.queries) await collect('GitLab', query, gitlabSearch, config.gitlab);
  const incompleteQueryCount = Object.values(providerStatistics).reduce((sum, item) => sum + Number(item.incomplete_query_count ?? 0), 0);
  const gate = coverageGate(config, attempted, searched, incompleteQueryCount);
  const coverage = {
    attempted_queries: attempted,
    successful_queries: searched,
    failed_queries: attempted - searched,
    coverage_status_zh: gate.publication_eligible
      ? (attempted === searched ? '本轮全部计划查询已完成。' : `本轮有 ${attempted - searched} 条查询未完成，但通过完整性闸门；详见覆盖缺口，结果不代表全网只有当前候选。`)
      : (incompleteQueryCount > 0
        ? `本轮有 ${incompleteQueryCount} 条查询返回不完整结果，未通过发布闸门；不会用此结果替换上一份合格目录。`
        : `本轮仅完成 ${(gate.actual_success_ratio * 100).toFixed(0)}% 查询，未达到发布闸门；不会用此结果替换上一份合格目录。`),
    provider_statistics: providerStatistics,
    query_runs: queryRuns,
    gaps: warnings.map((item) => ({
      provider: item.provider,
      query: item.query,
      error: item.error,
      provider_message: item.provider_message,
      http_status: item.http_status,
      failure_kind: item.failure_kind,
      response: item.response,
      handling_zh: item.handling_zh
    })),
    quality_gate: gate
  };
  if (!gate.publication_eligible && previous) return {
    catalog: previous,
    retained_previous: true,
    retention_reason_zh: `本轮查询完整度 ${(gate.actual_success_ratio * 100).toFixed(0)}% 未达到 ${(gate.minimum_success_ratio * 100).toFixed(0)}% 闸门，上一份合格目录已保留。`,
    coverage,
    warnings
  };
  if (searched === 0 && previous) return { catalog: previous, retained_previous: true, coverage, warnings };
  if (searched === 0) throw new Error(`所有 GitHub 搜索均失败：${warnings.map((item) => item.error).join('；')}`);
  // 通过硬性合格门槛后，按公开热度由高到低显示；更新时间只用于同热度时的稳定排序。
  const repositories = [...candidates.values()].sort((a, b) => b.hotness_score - a.hotness_score || b.quality_score - a.quality_score || String(b.updated_at).localeCompare(String(a.updated_at)) || a.repository.localeCompare(b.repository));
  const catalog = {
    schema_version: 1,
    scope_zh: config.scope_zh,
    source_tier: 'community_open_source',
    generated_at: isoTaipei(now),
    provider: 'GitHub and GitLab public repository metadata APIs',
    metadata_only: true,
    searched_queries: searched,
    query_coverage: coverage,
    discovery_efficiency: {
      ...filterSummary,
      unique_candidate_count: repositories.length,
      note_zh: '返回条目按每条查询累计，可能含重复项目；唯一候选在硬性许可证、时效、平台关联和风险规则筛选后去重。'
    },
    repository_count: repositories.length,
    warnings,
    safety: config.safety,
    repositories
  };
  await writeJsonAtomic(catalogPath, catalog);
  const index = await buildCommunityIndex({ catalog, catalogPath });
  const frontier = await buildFrontierCatalog({ catalog, config, frontierCatalogPath, now });
  const riskRegistry = await buildComplianceRiskRegistry({ observations: riskObservations, registryPath: riskRegistryPath, now });
  const sourceLedger = await buildResearchSourceLedger({ catalog, frontier: frontier.catalog, riskRegistry: riskRegistry.registry, ledgerPath: sourceLedgerPath, now });
  const resolvedReportPath = reportPath ?? (path.resolve(catalogPath) === path.resolve(COMMUNITY_CATALOG_PATH)
    ? COMMUNITY_RESEARCH_REPORT_PATH
    : path.join(path.dirname(catalogPath), '开源技术雷达-最新研究报告.md'));
  const report = await buildCommunityResearchReport({ catalog, riskRegistry: riskRegistry.registry, reportPath: resolvedReportPath, now });
  return { catalog, catalogPath, index, frontier, riskRegistry, sourceLedger, report, coverage, retained_previous: false, warnings };
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

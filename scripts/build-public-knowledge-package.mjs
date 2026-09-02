#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { exists, ensureDir, isoTaipei, listFilesRecursive, readJson, writeJsonAtomic } from '../src/lib/fs-utils.mjs';
import { KNOWLEDGE_SOURCE_ROOT } from '../src/lib/official-knowledge/constants.mjs';
import { COMMUNITY_CATALOG_PATH, FRONTIER_CATALOG_PATH, COMPLIANCE_RISK_REGISTRY_PATH } from '../src/lib/community-knowledge/open-source-radar.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const outputRoot = path.resolve(process.env.PUBLIC_KNOWLEDGE_OUTPUT_ROOT || path.join(projectRoot, 'published'));
const sourceRoot = path.resolve(process.env.PUBLIC_KNOWLEDGE_SOURCE_ROOT || KNOWLEDGE_SOURCE_ROOT);
const minimumUsable = Number(process.env.PUBLIC_KNOWLEDGE_MIN_SOURCES ?? 50);
const archiveName = 'meta-shopify-official-source-pack.tar.gz';
const communityCatalogName = 'community-open-source-catalog.json';
const communityCatalogPath = path.resolve(process.env.PUBLIC_COMMUNITY_CATALOG_PATH || COMMUNITY_CATALOG_PATH);
const frontierCatalogName = 'community-frontier-latest-30-days.json';
const frontierCatalogPath = path.resolve(process.env.PUBLIC_FRONTIER_CATALOG_PATH || FRONTIER_CATALOG_PATH);
const complianceRiskRegistryName = 'community-compliance-risk-registry.json';
const complianceRiskRegistryPath = path.resolve(process.env.PUBLIC_COMPLIANCE_RISK_REGISTRY_PATH || COMPLIANCE_RISK_REGISTRY_PATH);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function removeOwnedDirectory(target) {
  if (!inside(outputRoot, target)) throw new Error(`拒绝清理输出目录外的位置：${target}`);
  await fsp.rm(target, { recursive: true, force: true });
}

async function copyFile(source, target) {
  await ensureDir(path.dirname(target));
  await fsp.copyFile(source, target);
}

function assertPublishableCommunityCoverage(catalog) {
  const coverage = catalog.query_coverage;
  const gate = coverage?.quality_gate;
  const attempted = Number(coverage?.attempted_queries);
  const successful = Number(coverage?.successful_queries);
  const failed = Number(coverage?.failed_queries);
  if (!coverage || !gate || gate.publication_eligible !== true || !Number.isInteger(attempted) || attempted < 1 || !Number.isInteger(successful) || !Number.isInteger(failed) || successful + failed !== attempted) {
    throw new Error('开源技术目录查询完整度或发布闸门无效，拒绝公开发布。');
  }
  if (Number(gate.actual_success_ratio) < Number(gate.minimum_success_ratio)) {
    throw new Error('开源技术目录未达到查询完整度发布闸门，拒绝公开发布。');
  }
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

if (!(await exists(sourceRoot))) throw new Error(`找不到官方来源目录：${sourceRoot}`);
await ensureDir(outputRoot);
const stagingRoot = path.join(outputRoot, '.staging');
await removeOwnedDirectory(stagingRoot);
await ensureDir(path.join(stagingRoot, 'sources'));

const sourceJsonFiles = (await listFilesRecursive(sourceRoot)).filter((file) => path.basename(file) === 'source.json');
const packagedSources = [];
for (const sourceJsonPath of sourceJsonFiles) {
  const sourceDir = path.dirname(sourceJsonPath);
  const metadata = await readJson(sourceJsonPath);
  if (!['current', 'changed'].includes(metadata.status)) continue;
  const normalizedPath = path.join(sourceDir, 'normalized.md');
  if (!(await exists(normalizedPath))) continue;
  const targetDir = path.join(stagingRoot, 'sources', metadata.source_id);
  const publishedMetadata = {
    ...metadata,
    local_raw_path: null,
    local_normalized_path: path.posix.join('sources', metadata.source_id, 'normalized.md'),
    published_scope: 'official_public_source_snapshot'
  };
  await writeJsonAtomic(path.join(targetDir, 'source.json'), publishedMetadata);
  await copyFile(normalizedPath, path.join(targetDir, 'normalized.md'));
  packagedSources.push({
    source_id: metadata.source_id,
    publisher: metadata.publisher,
    canonical_url: metadata.canonical_url,
    content_hash: metadata.content_hash,
    normalized_chars: metadata.quality?.normalized_chars ?? null
  });
}

const previousManifestPath = path.join(outputRoot, 'manifest.json');
const previousManifest = await exists(previousManifestPath) ? await readJson(previousManifestPath) : null;
const previousUsable = Number(previousManifest?.usable_source_count ?? 0);
const floorFromPrevious = previousUsable ? Math.ceil(previousUsable * 0.95) : minimumUsable;
if (packagedSources.length < floorFromPrevious && process.env.PUBLIC_KNOWLEDGE_ALLOW_SHRINK !== '1') {
  throw new Error(`可发布官方来源仅 ${packagedSources.length} 条，低于发布门槛 ${floorFromPrevious}；已保留旧版本，拒绝覆盖。`);
}

const sourceManifest = {
  schema_version: 1,
  scope: 'official_public_source_snapshot',
  generated_at: isoTaipei(),
  usable_source_count: packagedSources.length,
  sources: packagedSources
};
await writeJsonAtomic(path.join(stagingRoot, 'source-manifest.json'), sourceManifest);

const archivePath = path.join(outputRoot, archiveName);
await fsp.rm(archivePath, { force: true });
await run('tar', ['-czf', archivePath, 'sources', 'source-manifest.json'], stagingRoot);
const archiveBytes = await fsp.readFile(archivePath);
let communityOpenSourceCatalog = null;
let communityFrontierCatalog = null;
let communityComplianceRiskRegistry = null;
if (await exists(communityCatalogPath)) {
  const catalog = await readJson(communityCatalogPath);
  const repositories = Array.isArray(catalog.repositories) ? catalog.repositories : [];
  if (catalog.schema_version !== 1 || catalog.source_tier !== 'community_open_source') {
    throw new Error('开源技术目录格式无效，拒绝公开发布。');
  }
  assertPublishableCommunityCoverage(catalog);
  if (repositories.some((item) => item.source_tier !== 'community_open_source' || Number(item.age_days) > 180 || !/^https:\/\/(github\.com|gitlab\.com)\//i.test(item.canonical_url ?? '') || item.automatic_adoption_allowed !== false || item.research_status !== 'research_only' || !Array.isArray(item.discovery_queries) || !Array.isArray(item.discovery_providers))) {
    throw new Error('开源技术目录包含非允许公开平台元数据或超过半年未更新项目，拒绝发布。');
  }
  const targetPath = path.join(outputRoot, communityCatalogName);
  await copyFile(communityCatalogPath, targetPath);
  const bytes = await fsp.readFile(targetPath);
  communityOpenSourceCatalog = {
    file: communityCatalogName,
    sha256: sha256(bytes),
    bytes: bytes.length,
    repository_count: repositories.length,
    maximum_age_days: 180,
    scope_zh: '第三方开源技术参考；不替代官方规则'
  };
}
if (await exists(frontierCatalogPath)) {
  const catalog = await readJson(frontierCatalogPath);
  const repositories = Array.isArray(catalog.repositories) ? catalog.repositories : [];
  if (catalog.schema_version !== 1 || catalog.source_tier !== 'community_open_source' || catalog.catalog_kind !== 'frontier_latest_30_days') {
    throw new Error('近 30 天前沿技术目录格式无效，拒绝公开发布。');
  }
  if (Number(catalog.maximum_age_days) !== 30 || repositories.some((item) => item.source_tier !== 'community_open_source' || Number(item.age_days) > 30 || !/^https:\/\/(github\.com|gitlab\.com)\//i.test(item.canonical_url ?? '') || item.automatic_adoption_allowed !== false || item.research_status !== 'research_only')) {
    throw new Error('近 30 天前沿技术目录包含非允许公开平台元数据或超出时间窗项目，拒绝发布。');
  }
  const targetPath = path.join(outputRoot, frontierCatalogName);
  await copyFile(frontierCatalogPath, targetPath);
  const bytes = await fsp.readFile(targetPath);
  communityFrontierCatalog = {
    file: frontierCatalogName,
    sha256: sha256(bytes),
    bytes: bytes.length,
    repository_count: repositories.length,
    maximum_age_days: 30,
    sort_order_zh: '更新时间优先，其次为质量与公开热度',
    scope_zh: '第三方开源前沿技术参考；不替代官方规则'
  };
}
if (await exists(complianceRiskRegistryPath)) {
  const registry = await readJson(complianceRiskRegistryPath);
  if (registry.schema_version !== 1 || registry.source_tier !== 'compliance_risk_research' || !Array.isArray(registry.categories)) {
    throw new Error('违规风险研究隔离库格式无效，拒绝公开发布。');
  }
  if (Object.hasOwn(registry, 'repositories') || Object.hasOwn(registry, 'canonical_url') || registry.categories.some((item) => Object.hasOwn(item, 'repository') || Object.hasOwn(item, 'canonical_url') || Object.hasOwn(item, 'terms'))) {
    throw new Error('违规风险研究隔离库包含可操作项目标识，拒绝公开发布。');
  }
  const targetPath = path.join(outputRoot, complianceRiskRegistryName);
  await copyFile(complianceRiskRegistryPath, targetPath);
  const bytes = await fsp.readFile(targetPath);
  communityComplianceRiskRegistry = {
    file: complianceRiskRegistryName,
    sha256: sha256(bytes),
    bytes: bytes.length,
    observed_candidate_count: Number(registry.observed_candidate_count ?? 0),
    data_handling_zh: '只含匿名聚合风险类别；不含项目标识、URL、代码或操作步骤'
  };
}
const manifest = {
  schema_version: 1,
  scope: 'Shopify × Meta 公开官方知识快照',
  generated_at: isoTaipei(),
  usable_source_count: packagedSources.length,
  source_floor: floorFromPrevious,
  archive: {
    file: archiveName,
    sha256: sha256(archiveBytes),
    bytes: archiveBytes.length,
    format: 'tar.gz'
  },
  community_open_source_catalog: communityOpenSourceCatalog,
  community_frontier_catalog: communityFrontierCatalog,
  community_compliance_risk_registry: communityComplianceRiskRegistry,
  local_apply: {
    rebuild_index: true,
    translate_changed_chunks_offline: true,
    preserve_last_known_good: true
  }
};
await writeJsonAtomic(previousManifestPath, manifest);
await removeOwnedDirectory(stagingRoot);
console.log(JSON.stringify(manifest, null, 2));

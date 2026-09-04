#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
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
  const incomplete = Number(gate?.incomplete_query_count ?? 0);
  const expectedRatio = attempted > 0 ? Math.round((successful / attempted) * 10_000) / 10_000 : 0;
  if (!coverage || !gate || gate.publication_eligible !== true || !Number.isInteger(attempted) || attempted < 1 || !Number.isInteger(successful) || !Number.isInteger(failed) || successful + failed !== attempted || !Number.isInteger(incomplete) || incomplete !== 0 || !Array.isArray(coverage.query_runs) || coverage.query_runs.length !== attempted) {
    throw new Error('开源技术目录查询完整度或发布闸门无效，拒绝公开发布。');
  }
  if (Math.abs(Number(gate.actual_success_ratio) - expectedRatio) > 0.0001 || Number(gate.actual_success_ratio) < Number(gate.minimum_success_ratio)) {
    throw new Error('开源技术目录未达到查询完整度发布闸门，拒绝公开发布。');
  }
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > length) throw new Error(`tar 字段过长：${value}`);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = `${Number(value).toString(8).padStart(length - 1, '0')}\0`;
  writeTarString(buffer, offset, length, encoded);
}

function stableTarEntry(name, bytes) {
  if (!/^[^/]+(?:\/[^/]+)*$/.test(name) || Buffer.byteLength(name) > 100) throw new Error(`tar 路径不安全或过长：${name}`);
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644); writeTarOctal(header, 108, 8, 0); writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.length); writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156); header[156] = '0'.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar'); writeTarString(header, 263, 2, '00');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeTarOctal(header, 148, 8, checksum);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512, 0);
  return Buffer.concat([header, bytes, padding]);
}

async function createStableArchive(output, root, entries) {
  const blocks = [];
  for (const entry of [...entries].sort()) blocks.push(stableTarEntry(entry, await fsp.readFile(path.join(root, entry))));
  blocks.push(Buffer.alloc(1024, 0));
  // gzipSync defaults to an mtime of zero, so the compressed bytes also remain stable.
  await fsp.writeFile(output, gzipSync(Buffer.concat(blocks), { mtime: 0 }));
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
  // The public package is a content snapshot, not a transport log. Excluding
  // request timestamps, validators and local paths prevents no-op refreshes
  // from republishing identical knowledge merely because a check was made.
  const publishedMetadata = {
    schema_version: 1,
    source_id: metadata.source_id,
    publisher: metadata.publisher,
    title: metadata.title,
    title_zh: metadata.title_zh,
    canonical_url: metadata.canonical_url,
    final_url: metadata.final_url,
    type: metadata.type,
    language: metadata.language,
    modules: metadata.modules,
    archive_mode: metadata.archive_mode,
    rights_status: metadata.rights_status,
    volatility: metadata.volatility,
    content_type: metadata.content_type,
    content_hash: metadata.content_hash,
    content_bytes: metadata.content_bytes,
    status: 'current',
    quality: {
      usable_for_index: true,
      normalized_chars: metadata.quality?.normalized_chars ?? null,
      reason: null
    },
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
packagedSources.sort((left, right) => String(left.source_id).localeCompare(String(right.source_id)));

const previousManifestPath = path.join(outputRoot, 'manifest.json');
const previousManifest = await exists(previousManifestPath) ? await readJson(previousManifestPath) : null;
const previousUsable = Number(previousManifest?.usable_source_count ?? 0);
const floorFromPrevious = previousUsable ? Math.ceil(previousUsable * 0.95) : minimumUsable;
if (packagedSources.length < floorFromPrevious && process.env.PUBLIC_KNOWLEDGE_ALLOW_SHRINK !== '1') {
  throw new Error(`可发布官方来源仅 ${packagedSources.length} 条，低于发布门槛 ${floorFromPrevious}；已保留旧版本，拒绝覆盖。`);
}

const sourceSnapshotHash = sha256(Buffer.from(JSON.stringify(packagedSources)));
const sourceGeneratedAt = previousManifest?.source_snapshot_hash === sourceSnapshotHash
  ? (previousManifest.source_generated_at || previousManifest.generated_at)
  : isoTaipei();
const sourceManifest = {
  schema_version: 1,
  scope: 'official_public_source_snapshot',
  generated_at: sourceGeneratedAt,
  snapshot_content_hash: sourceSnapshotHash,
  usable_source_count: packagedSources.length,
  sources: packagedSources
};
await writeJsonAtomic(path.join(stagingRoot, 'source-manifest.json'), sourceManifest);

const archivePath = path.join(outputRoot, archiveName);
await fsp.rm(archivePath, { force: true });
// Generate ustar bytes in Node rather than relying on host tar variants.
// Identical official content therefore has stable ordering, mtime and SHA-256
// on both GitHub Linux runners and local Windows verification.
const archiveEntries = ['source-manifest.json'];
for (const source of packagedSources) {
  archiveEntries.push(`sources/${source.source_id}/normalized.md`, `sources/${source.source_id}/source.json`);
}
await createStableArchive(archivePath, stagingRoot, archiveEntries);
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
  if (Number(catalog.repository_count) !== repositories.length) {
    throw new Error('开源技术目录候选数量与内容不一致，拒绝公开发布。');
  }
  if (repositories.some((item) => item.source_tier !== 'community_open_source' || Number(item.age_days) > 180 || !/^https:\/\/(github\.com|gitlab\.com)\//i.test(item.canonical_url ?? '') || item.automatic_adoption_allowed !== false || item.research_status !== 'research_only' || !Array.isArray(item.discovery_queries) || !Array.isArray(item.discovery_providers))) {
    throw new Error('开源技术目录包含非允许公开平台元数据或超过半年未更新项目，拒绝发布。');
  }
  const targetPath = path.join(outputRoot, communityCatalogName);
  // Re-serialize generated JSON so bytes are LF-stable on Windows and Linux.
  // Git line-ending normalization must never invalidate the published SHA-256.
  await writeJsonAtomic(targetPath, catalog);
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
  await writeJsonAtomic(targetPath, catalog);
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
  await writeJsonAtomic(targetPath, registry);
  const bytes = await fsp.readFile(targetPath);
  communityComplianceRiskRegistry = {
    file: complianceRiskRegistryName,
    sha256: sha256(bytes),
    bytes: bytes.length,
    observed_candidate_count: Number(registry.observed_candidate_count ?? 0),
    data_handling_zh: '只含匿名聚合风险类别；不含项目标识、URL、代码或操作步骤'
  };
}
const snapshotContent = {
  source_snapshot_hash: sourceSnapshotHash,
  community_open_source_sha256: communityOpenSourceCatalog?.sha256 ?? null,
  community_frontier_sha256: communityFrontierCatalog?.sha256 ?? null,
  community_compliance_risk_sha256: communityComplianceRiskRegistry?.sha256 ?? null
};
const snapshotContentHash = sha256(Buffer.from(JSON.stringify(snapshotContent)));
const generatedAt = previousManifest?.snapshot_content_hash === snapshotContentHash
  ? previousManifest.generated_at
  : isoTaipei();
const manifest = {
  schema_version: 1,
  scope: 'Shopify × Meta 公开官方知识快照',
  generated_at: generatedAt,
  snapshot_content_hash: snapshotContentHash,
  source_snapshot_hash: sourceSnapshotHash,
  source_generated_at: sourceGeneratedAt,
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

#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { exists, ensureDir, isoTaipei, listFilesRecursive, readJson, writeJsonAtomic } from '../src/lib/fs-utils.mjs';
import { KNOWLEDGE_SOURCE_ROOT } from '../src/lib/official-knowledge/constants.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const outputRoot = path.resolve(process.env.PUBLIC_KNOWLEDGE_OUTPUT_ROOT || path.join(projectRoot, 'published'));
const sourceRoot = path.resolve(process.env.PUBLIC_KNOWLEDGE_SOURCE_ROOT || KNOWLEDGE_SOURCE_ROOT);
const minimumUsable = Number(process.env.PUBLIC_KNOWLEDGE_MIN_SOURCES ?? 50);
const archiveName = 'meta-shopify-official-source-pack.tar.gz';

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
  local_apply: {
    rebuild_index: true,
    translate_changed_chunks_offline: true,
    preserve_last_known_good: true
  }
};
await writeJsonAtomic(previousManifestPath, manifest);
await removeOwnedDirectory(stagingRoot);
console.log(JSON.stringify(manifest, null, 2));

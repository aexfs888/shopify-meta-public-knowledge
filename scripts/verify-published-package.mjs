#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const outputRoot = path.resolve(process.env.PUBLIC_KNOWLEDGE_OUTPUT_ROOT || path.join(projectRoot, 'published'));

function fail(message) { throw new Error(`发布包复核失败：${message}`); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeName(value) { return typeof value === 'string' && value.length > 0 && value.length <= 200 && path.basename(value) === value && !value.includes('..'); }

const manifestPath = path.join(outputRoot, 'manifest.json');
const manifest = JSON.parse((await fsp.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
if (manifest.schema_version !== 1 || manifest.scope !== 'Shopify × Meta 公开官方知识快照') fail('manifest.json 格式不正确');

async function verifyEntry(entry, label) {
  if (!entry || !safeName(entry.file) || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || '')) || !Number.isInteger(Number(entry.bytes))) fail(`${label}清单字段无效`);
  const file = path.join(outputRoot, entry.file);
  const bytes = await fsp.readFile(file);
  if (bytes.length !== Number(entry.bytes)) fail(`${label}长度不一致`);
  if (sha256(bytes) !== String(entry.sha256).toLowerCase()) fail(`${label} SHA-256 不一致`);
  return file;
}

const archivePath = await verifyEntry(manifest.archive, '官方资料压缩包');
for (const [property, label] of [
  ['community_open_source_catalog', '开源技术目录'],
  ['community_frontier_catalog', '近30天技术目录'],
  ['community_compliance_risk_registry', '风险隔离目录'],
]) {
  if (manifest[property]) await verifyEntry(manifest[property], label);
}

const listed = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', windowsHide: true });
if (listed.status !== 0) fail(`压缩包目录无法读取：${String(listed.stderr || '').trim()}`);
const entries = String(listed.stdout || '').split(/\r?\n/).filter(Boolean);
if (entries.some((entry) => entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || /(^|\/)\.\.(\/|$)/.test(entry) || !(entry.startsWith('sources/') || entry === 'source-manifest.json'))) fail('压缩包含有越界或无关路径');
const sourceCount = entries.filter((entry) => /^sources\/[^/]+\/source\.json$/.test(entry)).length;
if (sourceCount !== Number(manifest.usable_source_count)) fail(`来源数量不一致：清单 ${manifest.usable_source_count}，压缩包 ${sourceCount}`);

console.log(JSON.stringify({ ok: true, usable_source_count: sourceCount, archive_sha256: manifest.archive.sha256 }, null, 2));

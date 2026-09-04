import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed ${code}: ${stderr}`)));
  });
}

async function writeSource(root, id, content) {
  const sourceDir = path.join(root, 'sources', id);
  await fsp.mkdir(sourceDir, { recursive: true });
  await fsp.writeFile(path.join(sourceDir, 'normalized.md'), `${content}\n`, 'utf8');
  await fsp.writeFile(path.join(sourceDir, 'source.json'), JSON.stringify({
    schema_version: 1, source_id: id, publisher: 'Meta', title: id, title_zh: id,
    canonical_url: `https://developers.facebook.com/docs/${id}`, final_url: `https://developers.facebook.com/docs/${id}`,
    type: 'developer', language: 'en', modules: ['tracking'], archive_mode: 'local_research_copy',
    rights_status: 'personal_local_research', volatility: 'high', content_type: 'text/html',
    content_hash: `${id}-hash`, content_bytes: content.length, status: 'current',
    etag: 'volatile-etag', last_checked_at: '2099-01-01T00:00:00+08:00', retrieved_at: '2099-01-01T00:00:00+08:00',
    quality: { usable_for_index: true, normalized_chars: content.length, reason: null }
  }, null, 2), 'utf8');
}

test('相同公开正文会生成稳定的发布快照，不因检查时间制造新版本', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'publisher-determinism-'));
  t.after(async () => fsp.rm(tmp, { recursive: true, force: true }));
  const sourceRoot = path.join(tmp, 'knowledge'); const outputRoot = path.join(tmp, 'published');
  await writeSource(sourceRoot, 'meta-a', 'Official guidance A');
  await writeSource(sourceRoot, 'meta-b', 'Official guidance B');
  const env = { ...process.env, PUBLIC_KNOWLEDGE_SOURCE_ROOT: sourceRoot, PUBLIC_KNOWLEDGE_OUTPUT_ROOT: outputRoot, PUBLIC_KNOWLEDGE_MIN_SOURCES: '1', PUBLIC_COMMUNITY_CATALOG_PATH: path.join(tmp, 'missing.json'), PUBLIC_FRONTIER_CATALOG_PATH: path.join(tmp, 'missing-frontier.json'), PUBLIC_COMPLIANCE_RISK_REGISTRY_PATH: path.join(tmp, 'missing-risk.json') };
  await run('node', ['scripts/build-public-knowledge-package.mjs'], { cwd: projectRoot, env });
  const first = JSON.parse(await fsp.readFile(path.join(outputRoot, 'manifest.json'), 'utf8'));
  await run('node', ['scripts/build-public-knowledge-package.mjs'], { cwd: projectRoot, env });
  const second = JSON.parse(await fsp.readFile(path.join(outputRoot, 'manifest.json'), 'utf8'));
  assert.equal(first.archive.sha256, second.archive.sha256);
  assert.equal(first.source_snapshot_hash, second.source_snapshot_hash);
  assert.equal(first.snapshot_content_hash, second.snapshot_content_hash);
  assert.equal(first.generated_at, second.generated_at);
  await run('node', ['scripts/verify-published-package.mjs'], { cwd: projectRoot, env });
});

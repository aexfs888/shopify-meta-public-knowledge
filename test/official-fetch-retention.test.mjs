import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncOfficialSource } from '../src/lib/official-knowledge/fetch.mjs';

const source = {
  source_id: 'meta-quality-retain',
  publisher: 'Meta',
  title_zh: '质量拒收保留测试',
  canonical_url: 'https://www.facebook.com/help/235353253505947',
  type: 'help',
  language: 'en',
  modules: ['assets'],
  volatility: 'high',
  rights_status: 'personal_local_research'
};

test('首次收到 HTTP 200 客户端空壳时拒绝进入索引', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publisher-quality-first-'));
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }));

  const result = await syncOfficialSource(source, {
    sourceRoot: path.join(dir, 'sources'),
    workspaceRoot: dir,
    fetchImpl: async () => new Response('<html><body>Account Security</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  });

  assert.equal(result.status, 'content_too_short');
  assert.equal(result.metadata.quality.usable_for_index, false);
});

test('HTTP 200 客户端空壳不会覆盖最后一次合格正文', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publisher-quality-retain-'));
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }));
  const sourceRoot = path.join(dir, 'sources');

  const first = await syncOfficialSource(source, {
    sourceRoot,
    workspaceRoot: dir,
    fetchImpl: async () => new Response(`<html><body>${'Stable official guidance. '.repeat(30)}</body></html>`, {
      headers: { 'content-type': 'text/html' }
    })
  });
  const originalNormalized = await fsp.readFile(path.join(sourceRoot, source.source_id, 'normalized.md'), 'utf8');

  const retained = await syncOfficialSource(source, {
    sourceRoot,
    workspaceRoot: dir,
    fetchImpl: async () => new Response('<html><body>Account Security</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  });

  assert.equal(retained.status, 'retained_previous');
  assert.equal(retained.error_code, 'content_too_short');
  assert.equal(retained.metadata.status, 'current');
  assert.equal(retained.metadata.content_hash, first.metadata.content_hash);
  assert.equal(retained.metadata.quality.usable_for_index, true);
  assert.equal(retained.metadata.last_quality_rejection.code, 'content_too_short');
  assert.equal(await fsp.readFile(path.join(sourceRoot, source.source_id, 'normalized.md'), 'utf8'), originalNormalized);
  assert.match(await fsp.readFile(path.join(sourceRoot, source.source_id, 'last-rejected.html'), 'utf8'), /Account Security/);
});

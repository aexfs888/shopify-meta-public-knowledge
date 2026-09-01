#!/usr/bin/env node
import { syncOfficialSources } from '../src/lib/official-knowledge/fetch.mjs';
import { SOURCE_CONFIG_PATH, KNOWLEDGE_MANIFEST_ROOT, KNOWLEDGE_SOURCE_ROOT } from '../src/lib/official-knowledge/constants.mjs';

const result = await syncOfficialSources({
  configPath: process.env.PUBLIC_KNOWLEDGE_SOURCE_CONFIG || SOURCE_CONFIG_PATH,
  sourceRoot: process.env.PUBLIC_KNOWLEDGE_SOURCE_ROOT || KNOWLEDGE_SOURCE_ROOT,
  manifestRoot: process.env.PUBLIC_KNOWLEDGE_MANIFEST_ROOT || KNOWLEDGE_MANIFEST_ROOT,
  delayMs: Number(process.env.PUBLIC_KNOWLEDGE_DELAY_MS ?? 650)
});

console.log(JSON.stringify({
  run_id: result.manifest.run_id,
  registered: result.manifest.selected_count,
  refreshed: result.manifest.success_count,
  retained_previous: result.manifest.retained_previous_count ?? 0,
  errors: result.manifest.error_count,
  manifest_path: result.manifestPath
}, null, 2));

// 首次取得失败的来源保留在清单中等待下次检查；已验证来源的临时失败
// 会保留上一次正文，因此不能因为单页异常就阻断整份公开知识包。
if (result.manifest.success_count + (result.manifest.retained_previous_count ?? 0) === 0) {
  throw new Error('本次未获得任何可用官方资料，拒绝发布空知识包。');
}

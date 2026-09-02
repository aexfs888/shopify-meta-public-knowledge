#!/usr/bin/env node
import { discoverOpenSourceTechnology } from '../src/lib/community-knowledge/open-source-radar.mjs';

const result = await discoverOpenSourceTechnology({
  configPath: process.env.PUBLIC_COMMUNITY_SOURCE_CONFIG,
  catalogPath: process.env.PUBLIC_COMMUNITY_CATALOG_PATH,
  token: process.env.GITHUB_TOKEN || ''
});
console.log(JSON.stringify({
  repositories: result.catalog.repository_count,
  queries: result.catalog.searched_queries,
  retained_previous: result.retained_previous,
  warnings: result.warnings.length,
  catalog_path: result.catalogPath ?? null
}, null, 2));

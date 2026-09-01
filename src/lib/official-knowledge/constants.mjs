import path from 'node:path';
import { workspacePath } from '../paths.mjs';

export const KNOWLEDGE_ROOT = workspacePath('knowledge', 'official', 'meta-shopify');
export const KNOWLEDGE_SOURCE_ROOT = path.join(KNOWLEDGE_ROOT, 'sources');
export const KNOWLEDGE_MANIFEST_ROOT = path.join(KNOWLEDGE_ROOT, 'manifests');
export const KNOWLEDGE_REPORT_ROOT = path.join(KNOWLEDGE_ROOT, 'refresh-reports');
export const KNOWLEDGE_DB_PATH = path.join(KNOWLEDGE_ROOT, 'index', 'knowledge.sqlite');
export const SOURCE_CONFIG_PATH = workspacePath('config', 'official-knowledge-sources.json');
export const DISCOVERY_ROOT = workspacePath('knowledge', 'research', 'value-discoveries');
export const DISCOVERY_LEDGER_PATH = path.join(DISCOVERY_ROOT, 'discovery-ledger.jsonl');

export const OFFICIAL_HOSTS = new Set([
  'developers.facebook.com',
  'www.facebook.com',
  'facebook.com',
  'business.facebook.com',
  'transparency.meta.com',
  'www.meta.com',
  'meta.com',
  'mcp.facebook.com',
  'www.postman.com',
  'postman.com',
  'help.shopify.com',
  'shopify.dev',
  'www.shopifyacademy.com',
  'shopifyacademy.com',
  'www.facebookblueprint.com',
  'facebookblueprint.com',
  'certifications.facebookblueprint.com'
]);

export const DISCOVERY_KEYWORDS = [
  'ads', 'advert', 'business', 'campaign', 'pixel', 'conversion', 'instagram',
  'facebook', 'meta', 'shopify', 'catalog', 'product', 'privacy', 'audience',
  'placement', 'creative', 'report', 'measurement', 'page', 'account', 'manager'
];

export const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 25_000;
export const FETCH_RETRIES = 2;
export const DEFAULT_USER_AGENT = 'HermesMetaLearning/1.0 (local educational knowledge cache)';

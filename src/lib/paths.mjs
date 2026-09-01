import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

export const ROOT = path.resolve(currentDir, '..', '..');

export function workspacePath(...parts) {
  return path.join(ROOT, ...parts);
}


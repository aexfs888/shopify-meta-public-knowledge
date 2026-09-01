import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`JSON 无法解析：${filePath}\n${error.message}`);
  }
}

export async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, filePath);
}

export async function writeTextAtomic(filePath, text) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, text, 'utf8');
  await fsp.rename(tempPath, filePath);
}

export async function writeBufferAtomic(filePath, buffer) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, buffer);
  await fsp.rename(tempPath, filePath);
}

export async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function isoLocalFileStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((item) => item.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}

export function isoTaipei(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(date).replace(' ', 'T') + '+08:00';
}

export async function listFilesRecursive(rootDir) {
  if (!(await exists(rootDir))) return [];
  const result = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) result.push(fullPath);
    }
  }
  return result.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

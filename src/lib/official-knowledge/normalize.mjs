const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…'
};

export function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITY_MAP[name.toLowerCase()] ?? match);
}

export function extractTitle(html, fallback = '') {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const title = og?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? fallback;
  return normalizeWhitespace(decodeHtmlEntities(title.replace(/<[^>]+>/g, ' ')));
}

export function htmlToMarkdown(html) {
  let text = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|canvas|noscript|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '\n$1')
    .replace(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi, '$2 | ')
    .replace(/<(p|div|section|article|br|hr)[^>]*>/gi, '\n')
    .replace(/<\/((p|div|section|article))>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text).replace(/\r/g, '');
  const lines = text.split('\n').map((line) => normalizeWhitespace(line)).filter(Boolean);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeWhitespace(text) {
  return String(text).replace(/[\t\f\v ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function extractOfficialLinks(html, baseUrl) {
  const result = new Set();
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) != null) {
    try {
      result.add(new URL(decodeHtmlEntities(match[1]), baseUrl).toString());
    } catch {
      // 忽略 mailto、javascript 和损坏链接。
    }
  }
  return [...result];
}

export function chunkMarkdown(markdown, { maxChars = 1400, overlapChars = 180 } = {}) {
  const text = String(markdown).trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}|(?=\n#{1,4} )/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      chunks.push(current.trim());
      const tail = current.slice(Math.max(0, current.length - overlapChars));
      current = `${tail}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}


const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}
// A restrictive serializer, not a pass-through HTML cleaner: only exact basic
// formatting tags and a single validated href attribute are ever emitted.
export function safeEmailHtml(source) {
  if (typeof source !== 'string') return '';
  return (source.match(/<[^<>]*>|[^<]+|</gu) || []).map(part => {
    if (!part.startsWith('<')) return escapeHtml(decodeEntities(part));
    const basic = part.match(/^<\s*(\/?)\s*(strong|b|em|i|p|div|br)\s*\/?\s*>$/iu);
    if (basic) return `<${basic[1]}${basic[2].toLowerCase()}>`;
    if (/^<\/a\s*>$/iu.test(part)) return '</a>';
    const anchor = part.match(/^<a\s+href\s*=\s*(["'])(.*?)\1\s*>$/iu);
    if (anchor) {
      try {
        const url = new URL(decodeEntities(anchor[2]).trim());
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return `<a href="${escapeHtml(url.href)}">`;
      } catch { /* Unsupported links are rendered as their text only. */ }
    }
    return '';
  }).join('');
}

import { describe, expect, it } from 'vitest';
import { safeEmailHtml } from './emailFormatting.js';
describe('restricted email formatting serializer', () => {
  it('preserves only basic formatting and paragraph breaks', () => { expect(safeEmailHtml('<p><b>Bold</b> and <i>italic</i><br>next</p>')).toBe('<p><b>Bold</b> and <i>italic</i><br>next</p>'); });
  it('keeps safe links and escapes their query attributes', () => { expect(safeEmailHtml('<a href="https://example.com/?a=1&amp;b=2">Visit</a>')).toBe('<a href="https://example.com/?a=1&amp;b=2">Visit</a>'); });
  it.each(['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html,bad', 'file:///tmp/x', 'https://user:pass@example.com'])('rejects unsafe link protocols or credentials', href => { expect(safeEmailHtml(`<a href="${href}">text</a>`)).not.toContain('href='); });
  it('never emits scripts, images, embedded content, styles or event handlers', () => {
    const result = safeEmailHtml('<script>alert(1)</script><img src=x onerror=bad><iframe src=x></iframe><b onclick="bad">ok</b><style>bad</style>');
    expect(result).not.toMatch(/<(?:script|img|iframe|style)|onclick|onerror/); expect(result).toContain('ok');
  });
  it('does not turn encoded markup into executable markup', () => { expect(safeEmailHtml('&lt;img src=x onerror=bad&gt;')).toBe('&lt;img src=x onerror=bad&gt;'); });
  it('rejects additional anchor attributes', () => { expect(safeEmailHtml('<a href="https://example.com" onclick="bad">text</a>')).not.toContain('href='); });
  it('escapes text around malformed and quoted tags', () => { expect(safeEmailHtml('<img title=">" onerror="bad">Hello')).not.toContain('<img'); });
  it('handles Unicode numeric entities without throwing', () => { expect(safeEmailHtml('&#x1f44b; &#99999999;')).toBe('👋 �'); });
  it('accepts absent optional formatting', () => { expect(safeEmailHtml(undefined)).toBe(''); });
  it('handles large malformed markup without generating executable tags', () => { expect(safeEmailHtml('<'.repeat(100000))).toBe(''); });
});

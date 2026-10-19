import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmailComposerDrawer } from './EmailComposerDrawer';
import { canSend, confirmedMail, contactOptions, emailAddress, emailLink, mailStatus, mailTemplates, sendPayload } from './composerModel';
vi.mock('../../context/AppContext', () => ({ useApp: () => ({ user: { role: 'member' }, toast: vi.fn() }) }));
vi.mock('../../components/ui', () => ({ Drawer: ({ children }: { children: React.ReactNode }) => <aside role="dialog">{children}</aside> }));
const payload = sendPayload('customer@example.com', 'Hello', 'Welcome', '<b>Welcome</b>', 'fixture-key');
describe('email composer contracts', () => {
  it('normalizes a single recipient', () => { expect(emailAddress(' CUSTOMER@example.com ')).toBe('customer@example.com'); });
  it.each(['a@example.com,b@example.com', 'a@example.com\nBcc:b@example.com', 'not-email'])('rejects invalid or multiple recipients', address => { expect(() => sendPayload(address, '', 'body', '', 'key')).toThrow(); });
  it('requires message content', () => { expect(() => sendPayload('a@example.com', '', ' ', '', 'key')).toThrow(); });
  it('keeps formatting separate from plain text', () => { expect(payload.html).toBe('<b>Welcome</b>'); expect(payload.body).toBe('Welcome'); });
  it('supports both contact API envelope shapes and removes unusable addresses', () => {
    const rows = [{ id: '1', name: 'Customer', email: 'CUSTOMER@example.com' }, { id: '2', email: '' }, { id: '3', email: 'customer@example.com' }];
    expect(contactOptions(rows)).toEqual(contactOptions({ data: rows })); expect(contactOptions(rows)).toHaveLength(1);
  });
  it('filters SMS templates', () => { expect(mailTemplates([{ id: '1', name: 'Hi', subject: 'Hi', body: 'Body', channel: 'SMS' }])).toEqual([]); });
  it.each(['javascript:alert(1)', 'data:text/html,x', 'https://user:password@example.com'])('rejects unsafe links', link => { expect(() => emailLink(link)).toThrow(); });
  it('accepts HTTP(S) links', () => { expect(emailLink('https://example.com')).toBe('https://example.com/'); });
  it.each(['Sent', 'Saved', 'Queued'])('accepts a confirmed %s response with truthful status', status => {
    expect(confirmedMail({ ...payload, id: 'm_1', status }, payload).status).toBe(status); expect(mailStatus(status)).not.toBe('Delivery failed');
  });
  it('does not claim Saved means sent', () => { expect(mailStatus('Saved')).toContain('not configured'); });
  it('retains failure as a draft error', () => { expect(() => confirmedMail({ ...payload, id: 'm_1', status: 'Failed' }, payload)).toThrow('draft is retained'); });
  it('rejects a response for a different message', () => { expect(() => confirmedMail({ ...payload, id: 'm_1', status: 'Sent', to: 'other@example.com' }, payload)).toThrow('could not be confirmed'); });
  it('limits write access to supported roles', () => { expect(canSend('Owner')).toBe(true); expect(canSend('viewer')).toBe(false); });
  it('renders the contact picker, template selector and formatting controls', () => {
    const html = renderToStaticMarkup(<EmailComposerDrawer onClose={vi.fn()} onSent={vi.fn()} />);
    for (const label of ['To *', 'Subject', 'Template', 'Body *', 'Bold', 'Italic', 'Link', 'Send']) expect(html).toContain(label);
    expect(html).toContain('<datalist'); expect(html).toContain('email-compose-surface'); expect(html).toContain('contenteditable="true"');
  });
});

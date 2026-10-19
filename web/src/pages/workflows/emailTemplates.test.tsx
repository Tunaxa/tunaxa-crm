import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailTemplatePreview, EmailTemplateSelector } from "./EmailTemplateSelector";
import { ActionConfigPanel } from "./ActionConfigPanel";
import { isSendEmail, parseEmailTemplates, templateConfiguration, templateParts } from "./emailTemplates";

const template = { id: "tpl_1", name: "Welcome", subject: "Hello {{name}}", body: "Hi {{ contact.name }}\nVisit {{website}}" };
describe("workflow email templates", () => {
  it("reads the template API array and excludes SMS templates", () => { expect(parseEmailTemplates([template, { ...template, id: "sms", channel: "SMS" }])).toEqual([template]); });
  it("accepts a confirmed empty collection", () => { expect(parseEmailTemplates([])).toEqual([]); });
  it.each([null, { data: [template] }, [null], [{ ...template, body: undefined }], [template, template]])("rejects invalid template data", input => { expect(() => parseEmailTemplates(input)).toThrow(); });
  it.each(["Send Email", "send_email", "sendEmail", "email"])("recognizes existing email action aliases: %s", type => { expect(isSendEmail(type)).toBe(true); });
  it("does not treat other actions as email", () => { expect(isSendEmail("sms")).toBe(false); });
  it("preserves text and line breaks while separating repeated and nested tags", () => {
    const parts = templateParts("Hi {{name}}\n{{ contact.name }} {{name}}!");
    expect(parts.filter(part => part.mergeTag).map(part => part.value)).toEqual(["{{name}}", "{{ contact.name }}", "{{name}}"]);
    expect(parts.map(part => part.value).join("")).toBe("Hi {{name}}\n{{ contact.name }} {{name}}!");
  });
  it("leaves unsupported or incomplete tags as ordinary text", () => { expect(templateParts("{{name|fallback}} {{unfinished").some(part => part.mergeTag)).toBe(false); });
  it("keeps the selected template content and unrelated action settings", () => {
    const configuration = { to: "{{email}}", custom: "keep" };
    expect(templateConfiguration(configuration, template)).toEqual({ ...configuration, templateId: "tpl_1", subject: template.subject, body: template.body });
    expect(configuration).toEqual({ to: "{{email}}", custom: "keep" });
  });
  it("does not erase subject/body when clearing the template reference", () => { expect(templateConfiguration({ templateId: "tpl_1", body: "Edited", subject: "Custom" }, null)).toEqual({ body: "Edited", subject: "Custom" }); });
  it("renders merge tags with a distinct mark in the subject and body", () => {
    const html = renderToStaticMarkup(<EmailTemplatePreview template={template} />);
    expect(html.match(/<mark /g)).toHaveLength(3); expect(html).toContain("{{name}}"); expect(html).toContain("Selected email template preview");
  });
  it("never executes template markup or makes template links clickable", () => {
    const html = renderToStaticMarkup(<EmailTemplatePreview template={{ ...template, body: '<script>alert(1)</script><img src="https://tracker.example"> {{name}}' }} />);
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img "); expect(html).toContain("&lt;script&gt;"); expect(html).toContain('class="email-merge-tag"');
  });
  it("exposes a labelled loading selector without a false empty state", () => {
    const html = renderToStaticMarkup(<EmailTemplateSelector templateId="" onSelect={vi.fn()} />);
    expect(html).toContain("Email template"); expect(html).toContain("Loading email templates"); expect(html).not.toContain("No email templates yet"); expect(html).toMatch(/<select[^>]*disabled/);
  });
  it("only shows the template selector in Send Email action configuration", () => {
    const props = { templateId: "", onSelect: vi.fn(), onClose: vi.fn() };
    expect(renderToStaticMarkup(<ActionConfigPanel {...props} actionType="send_email" />)).toContain("<select");
    expect(renderToStaticMarkup(<ActionConfigPanel {...props} actionType="task" />)).not.toContain("<select");
  });
});

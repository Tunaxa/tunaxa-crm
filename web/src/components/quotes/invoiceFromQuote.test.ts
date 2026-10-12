import { describe, expect, it } from "vitest";
import { invoiceFromQuote } from "./invoiceFromQuote";

describe("invoiceFromQuote", () => {
  it("preserves the saved final total without applying discount or tax twice", () => {
    const items = [{ productName: "Service", quantity: 2, unitPrice: 100 }];
    const result = invoiceFromQuote({ id: "q1", number: "Q-1", customer: "Acme",
      status: "Accepted", total: 216, subtotal: 200, discount: 10,
      discountAmount: 20, tax: 20, taxAmount: 36, items }, "INV-1", "2026-09-27");
    expect(result).toMatchObject({ number: "INV-1", quoteId: "q1", quoteNumber: "Q-1",
      customerName: "Acme", amount: 216, status: "Draft", issueDate: "2026-09-27",
      dueDate: "", items, taxAmount: 36, discountAmount: 20 });
    expect(result).not.toHaveProperty("id");
  });

  it("supports legacy quotes without items and accepts a zero total", () => {
    expect(invoiceFromQuote({ id: "q1", total: "0", tax: "invalid" }, "INV-1", "2026-09-27"))
      .toMatchObject({ amount: 0, customerName: "", customerEmail: "" });
    expect(invoiceFromQuote({ id: "q1", total: 25 }, "INV-1", "2026-09-27"))
      .not.toHaveProperty("items");
  });

  it.each([undefined, null, "", " ", "invalid", -1, Infinity, true, []])(
    "rejects an invalid total (%s) instead of creating an incorrect bill", (total) => {
      expect(() => invoiceFromQuote({ id: "q1", total }, "INV-1", "2026-09-27")).toThrow();
    },
  );

  it("requires the original quote reference", () => {
    expect(() => invoiceFromQuote({ total: 50 }, "INV-1", "2026-09-27")).toThrow();
  });
});

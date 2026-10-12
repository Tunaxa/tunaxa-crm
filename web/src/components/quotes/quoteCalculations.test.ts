import { describe, expect, it } from "vitest";
import {
  calculateQuoteTotals,
  normalizeQuoteLineItems,
  quoteLineTotal,
} from "./quoteCalculations";

describe("quote calculations", () => {
  it("calculates line totals and rounds to cents", () => {
    expect(quoteLineTotal({ quantity: 3, unitPrice: 19.995 })).toBe(59.99);
  });

  it("applies discount before tax", () => {
    expect(
      calculateQuoteTotals(
        [
          { quantity: 2, unitPrice: 50 },
          { quantity: 1, unitPrice: 25 },
        ],
        10,
        20,
      ),
    ).toEqual({
      subtotal: 125,
      discountPercent: 10,
      discountAmount: 12.5,
      taxPercent: 20,
      taxAmount: 22.5,
      total: 135,
    });
  });

  it("clamps percentages and negative item values", () => {
    expect(
      calculateQuoteTotals([{ quantity: -2, unitPrice: 50 }], 125, -10),
    ).toEqual({
      subtotal: 0,
      discountPercent: 100,
      discountAmount: 0,
      taxPercent: 0,
      taxAmount: 0,
      total: 0,
    });
  });

  it("normalizes legacy line item property names", () => {
    expect(
      normalizeQuoteLineItems([{ id: "line-1", name: "Setup", qty: "2", price: "45" }]),
    ).toEqual([
      { id: "line-1", productName: "Setup", quantity: 2, unitPrice: 45 },
    ]);
  });

  it("preserves the previous text line-item format", () => {
    expect(normalizeQuoteLineItems("Implementation x3 = 150\nSupport")).toEqual([
      {
        id: "legacy-line-1",
        productName: "Implementation",
        quantity: 3,
        unitPrice: 50,
      },
      {
        id: "legacy-line-2",
        productName: "Support",
        quantity: 1,
        unitPrice: 0,
      },
    ]);
  });
});

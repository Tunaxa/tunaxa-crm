export type QuoteLineItem = {
  id: string;
  productName: string;
  quantity: number;
  unitPrice: number;
};

export type StoredQuoteLineItem = Partial<QuoteLineItem> & {
  name?: unknown;
  product?: unknown;
  qty?: unknown;
  price?: unknown;
};

const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function quoteLineTotal(item: Pick<QuoteLineItem, "quantity" | "unitPrice">) {
  const quantity = Number.isFinite(Number(item.quantity)) ? Math.max(0, Number(item.quantity)) : 0;
  const unitPrice = Number.isFinite(Number(item.unitPrice)) ? Math.max(0, Number(item.unitPrice)) : 0;
  return cents(quantity * unitPrice);
}

export function calculateQuoteTotals(
  items: Pick<QuoteLineItem, "quantity" | "unitPrice">[],
  discountPercent: number,
  taxPercent: number,
) {
  const subtotal = cents(items.reduce((sum, item) => sum + quoteLineTotal(item), 0));
  const discountRate = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const taxRate = Math.min(100, Math.max(0, Number(taxPercent) || 0));
  const discountAmount = cents(subtotal * (discountRate / 100));
  const taxableAmount = cents(subtotal - discountAmount);
  const taxAmount = cents(taxableAmount * (taxRate / 100));

  return {
    subtotal,
    discountPercent: discountRate,
    discountAmount,
    taxPercent: taxRate,
    taxAmount,
    total: cents(taxableAmount + taxAmount),
  };
}

export function createQuoteLineItem(): QuoteLineItem {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `line-${Date.now()}-${Math.random()}`,
    productName: "",
    quantity: 1,
    unitPrice: 0,
  };
}

export function normalizeQuoteLineItems(value: unknown): QuoteLineItem[] {
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const match = line.match(/^(.*?)\s+x(\d+(?:\.\d+)?)\s*=\s*[$€£]?([\d,.]+)$/i);
        const quantity = Number(match?.[2] ?? 1);
        const legacyTotal = Number((match?.[3] ?? "0").replace(/,/g, ""));

        return {
          id: `legacy-line-${index + 1}`,
          productName: (match?.[1] || line).trim(),
          quantity,
          unitPrice: quantity > 0 ? cents(legacyTotal / quantity) : 0,
        };
      });
  }
  if (!Array.isArray(value)) return [createQuoteLineItem()];

  const items = value.map((raw, index) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as StoredQuoteLineItem;
    const quantity = Number(item.quantity ?? item.qty ?? 1);
    const unitPrice = Number(item.unitPrice ?? item.price ?? 0);

    return {
      id: String(item.id || `line-${index + 1}`),
      productName: String(item.productName ?? item.name ?? item.product ?? ""),
      quantity: Number.isFinite(quantity) ? Math.max(0, quantity) : 1,
      unitPrice: Number.isFinite(unitPrice) ? Math.max(0, unitPrice) : 0,
    };
  });

  return items.length ? items : [createQuoteLineItem()];
}

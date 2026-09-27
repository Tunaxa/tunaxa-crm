export function invoiceFromQuote(quote: Record<string, unknown>, number: string, issueDate: string) {
  const amount = typeof quote.total === "number" ||
    (typeof quote.total === "string" && quote.total.trim())
    ? Number(quote.total) : NaN;
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error("Save a valid quote total before generating an invoice.");
  if (typeof quote.id !== "string" || !quote.id)
    throw new Error("The quote reference is missing. Reload the quote and try again.");

  // Finance uses amount as the final billed total, including discount and tax.
  // Copy only invoice fields; never carry over the quote's id or status.
  return {
    number,
    quoteId: quote.id,
    quoteNumber: typeof quote.number === "string" ? quote.number : "",
    customerName: typeof quote.customer === "string" ? quote.customer : "",
    customerEmail: typeof quote.customerEmail === "string" ? quote.customerEmail : "",
    amount,
    status: "Draft",
    issueDate,
    dueDate: "",
    ...(Array.isArray(quote.items) || typeof quote.items === "string" ? { items: quote.items } : {}),
    ...Object.fromEntries(
      ["subtotal", "discount", "discountAmount", "tax", "taxAmount"].flatMap((key) => {
        const value = quote[key];
        if (value == null || value === "" || typeof value === "boolean") return [];
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric >= 0 ? [[key, numeric]] : [];
      }),
    ),
  };
}

import { useState } from "react";
import { Drawer } from "../ui";
import { useApp } from "../../context/AppContext";
import {
  calculateQuoteTotals,
  createQuoteLineItem,
  normalizeQuoteLineItems,
  quoteLineTotal,
  type QuoteLineItem,
} from "./quoteCalculations";

type QuoteFormProps = {
  title: string;
  initial: Record<string, any>;
  onClose: () => void;
  onSave: (data: Record<string, any>) => Promise<void>;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const statuses = ["Draft", "Sent", "Accepted", "Declined", "Expired"];

export function QuoteForm({ title, initial, onClose, onSave }: QuoteFormProps) {
  const { toast } = useApp();
  const [number, setNumber] = useState(String(initial.number ?? ""));
  const [customer, setCustomer] = useState(String(initial.customer ?? ""));
  const [status, setStatus] = useState(String(initial.status ?? statuses[0]));
  const [expiryDate, setExpiryDate] = useState(String(initial.expiryDate ?? ""));
  const [discount, setDiscount] = useState(Number(initial.discount ?? 0));
  const [tax, setTax] = useState(Number(initial.tax ?? 0));
  const [items, setItems] = useState<QuoteLineItem[]>(() =>
    normalizeQuoteLineItems(initial.items),
  );
  const [busy, setBusy] = useState(false);
  const totals = calculateQuoteTotals(items, discount, tax);

  function updateItem(id: string, changes: Partial<QuoteLineItem>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  async function save() {
    if (!number.trim()) return toast("Quote number is required", "error");
    if (!items.length) return toast("Add at least one line item", "error");
    if (items.some((item) => !item.productName.trim()))
      return toast("Every line item needs a product name", "error");
    if (items.some((item) => item.quantity <= 0))
      return toast("Line item quantities must be greater than zero", "error");
    if (items.some((item) => item.unitPrice < 0))
      return toast("Unit prices cannot be negative", "error");

    setBusy(true);
    try {
      await onSave({
        number: number.trim(),
        customer: customer.trim(),
        items: items.map((item) => ({
          ...item,
          productName: item.productName.trim(),
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: quoteLineTotal(item),
        })),
        subtotal: totals.subtotal,
        discount: totals.discountPercent,
        discountAmount: totals.discountAmount,
        tax: totals.taxPercent,
        taxAmount: totals.taxAmount,
        total: totals.total,
        status,
        expiryDate,
      });
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={title}
      subtitle="Build the quote and totals from individual products or services."
      width={780}
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save quote"}
          </button>
        </>
      }
    >
      <div className="quote-form">
        <div className="quote-form-basics">
          <label className="field">
            <span>
              Quote number <em className="required-mark">*</em>
            </span>
            <input value={number} onChange={(event) => setNumber(event.target.value)} />
          </label>
          <label className="field">
            <span>Customer / deal</span>
            <input value={customer} onChange={(event) => setCustomer(event.target.value)} />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {statuses.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Expiry date</span>
            <input
              type="date"
              value={expiryDate}
              onChange={(event) => setExpiryDate(event.target.value)}
            />
          </label>
        </div>

        <section className="quote-line-items" aria-labelledby="quote-line-items-title">
          <div className="quote-line-items-heading">
            <div>
              <h3 id="quote-line-items-title">Line items</h3>
              <p>Add each product or service included in this quote.</p>
            </div>
            <button
              type="button"
              className="btn secondary compact"
              onClick={() => setItems((current) => [...current, createQuoteLineItem()])}
            >
              Add line item
            </button>
          </div>

          <div className="quote-line-items-list">
            {items.map((item, index) => (
              <div className="quote-line-item" key={item.id}>
                <label className="field quote-line-product">
                  <span>Product name</span>
                  <input
                    value={item.productName}
                    placeholder="Product or service"
                    onChange={(event) =>
                      updateItem(item.id, { productName: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Qty</span>
                  <input
                    type="number"
                    min="0.01"
                    step="any"
                    value={item.quantity}
                    onChange={(event) =>
                      updateItem(item.id, { quantity: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  <span>Unit price</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={item.unitPrice}
                    onChange={(event) =>
                      updateItem(item.id, { unitPrice: Number(event.target.value) })
                    }
                  />
                </label>
                <div className="quote-line-total">
                  <span>Line total</span>
                  <strong>{currency.format(quoteLineTotal(item))}</strong>
                </div>
                <button
                  type="button"
                  className="icon-btn tiny danger-link quote-line-remove"
                  aria-label={`Remove line item ${index + 1}`}
                  title="Remove line item"
                  onClick={() => removeItem(item.id)}
                >
                  ×
                </button>
              </div>
            ))}
            {!items.length ? (
              <p className="quote-line-items-empty">
                No line items yet. Use “Add line item” to add a product or service.
              </p>
            ) : null}
          </div>

          <div className="quote-totals">
            <div className="quote-total-row">
              <span>Subtotal</span>
              <strong>{currency.format(totals.subtotal)}</strong>
            </div>
            <label className="quote-total-row">
              <span>Discount (%)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={discount}
                onChange={(event) =>
                  setDiscount(Math.min(100, Math.max(0, Number(event.target.value) || 0)))
                }
              />
              <strong>−{currency.format(totals.discountAmount)}</strong>
            </label>
            <label className="quote-total-row">
              <span>Tax (%)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={tax}
                onChange={(event) =>
                  setTax(Math.min(100, Math.max(0, Number(event.target.value) || 0)))
                }
              />
              <strong>{currency.format(totals.taxAmount)}</strong>
            </label>
            <div className="quote-total-row quote-grand-total">
              <span>Grand total</span>
              <strong>{currency.format(totals.total)}</strong>
            </div>
          </div>
        </section>
      </div>
    </Drawer>
  );
}

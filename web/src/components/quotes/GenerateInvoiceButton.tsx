import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../../context/AppContext";
import { api, json } from "../../lib/api";
import { invoiceFromQuote } from "./invoiceFromQuote";

export function GenerateInvoiceButton({ quote }: { quote: Record<string, unknown> }) {
  const { toast, user } = useApp();
  const navigate = useNavigate();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  // A successful response without an id must not invite another creation attempt.
  const [created, setCreated] = useState(false);

  if (user?.role !== "admin" && user?.role !== "member") return null;

  async function generate() {
    if (pending.current || created) return;
    pending.current = true;
    setBusy(true);
    try {
      const today = new Date();
      const issueDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const payload = invoiceFromQuote(
        quote,
        `INV-${crypto.randomUUID()}`,
        issueDate,
      );
      const invoice = await api<{ id?: unknown } | null>("/invoices", json("POST", payload));
      setCreated(true);
      if (typeof invoice?.id !== "string" || !invoice.id) {
        toast("Invoice created, but its link is missing. Open Invoices to find it.", "error");
        return;
      }
      toast("Invoice generated");
      navigate(`/invoices/${encodeURIComponent(invoice.id)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not generate invoice", "error");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn primary compact" disabled={busy || created}
      aria-busy={busy} onClick={generate}>
      {busy ? "Generating invoice…" : created ? "Invoice created" : "Generate Invoice"}
    </button>
  );
}

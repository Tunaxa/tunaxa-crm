import { useState } from "react";
import { Link } from "react-router-dom";
import "./contractDetails.css";
import { money } from "../ui";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

export function contractSummaryValue(value: unknown, type?: string, key?: string) {
  if (value == null || value === "") return "Unavailable";
  if (type === "checkbox") {
    if (value === true || value === "true") return "Yes";
    if (value === false || value === "false") return "No";
    return "Unavailable";
  }
  if (type === "number") {
    if (typeof value !== "number" && typeof value !== "string") return "Unavailable";
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || (typeof value === "string" && !value.trim())) return "Unavailable";
    return key === "value" || key === "mrr" ? money(numeric) : String(numeric);
  }
  return text(value) || "Unavailable";
}

export function signatureImageSource(value: unknown) {
  const source = text(value);
  if (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(source) ||
      /^data:image\/svg\+xml;(charset=utf-8,|base64,)/i.test(source)) return source;
  if (source.startsWith("/uploads/") && !source.includes("\\")) return source;
  return "";
}

export function contractSignature(record: Record<string, unknown>) {
  const signature = object(record.signature);
  const timestamp = text(signature.signedAt);
  const date = timestamp ? new Date(timestamp) : null;
  return {
    name: text(signature.signerName) || text(signature.typedName),
    email: text(signature.signerEmail),
    ip: text(signature.signerIp),
    timestamp: date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "",
    image: signatureImageSource(signature.imageDataUrl),
  };
}

function SignaturePreview({ source }: { source: string }) {
  const [failed, setFailed] = useState(false);
  return source && !failed ? (
    <img className="contract-signature-image" src={source}
      alt="Recorded contract signature" onError={() => setFailed(true)} />
  ) : <p>Signature image unavailable.</p>;
}

export function ContractDetails({ record }: { record: Record<string, unknown> }) {
  const quoteId = text(record.quoteId);
  const signature = contractSignature(record);
  return (
    <>
      <section className="detail-section" aria-labelledby="contract-quote-title">
        <h3 id="contract-quote-title">Original quote</h3>
        {quoteId ? (
          <Link className="btn secondary compact" to={`/quotes/${encodeURIComponent(quoteId)}`}>
            {text(record.quoteNumber) || "View original quote"}
          </Link>
        ) : <p>No original quote reference available.</p>}
      </section>
      <section className="detail-section" aria-labelledby="contract-signature-title">
        <h3 id="contract-signature-title">Signature information</h3>
        <dl className="detail-props">
          <div><dt>Signer name</dt><dd>{signature.name || "Unavailable"}</dd></div>
          <div><dt>Signer email</dt><dd>{signature.email || "Unavailable"}</dd></div>
          <div><dt>Signer IP address</dt><dd>{signature.ip || "Unavailable"}</dd></div>
          <div><dt>Signed at</dt><dd>{signature.timestamp || "Unavailable"}</dd></div>
        </dl>
        <SignaturePreview key={signature.image} source={signature.image} />
      </section>
    </>
  );
}

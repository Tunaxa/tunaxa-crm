// ---------- PG ↔ legacy-JSON shape adapters ----------
// The REST API surface and test suite use the legacy flat schema:
//   { id, name, email, phone, status, value, createdAt, updatedAt, ... }
// The PG repositories use snake_case column names.
// These helpers translate in both directions so all existing callers
// continue to work unchanged.
//
// Pure functions with no dependencies, so both route modules can share them
// without importing each other.

/**
 * Resources whose rows live in Postgres rather than the JSON store. Both the
 * write path (routes/resources.js) and the read path that duplicate detection
 * depends on (routes/dataops.js) must agree on this set; keeping one copy here
 * is what stops the two from drifting apart again.
 */
export const PG_RESOURCES = new Set(["contacts", "leads"]);

/**
 * Convert a PG row (snake_case, Dates) → legacy API shape (camelCase strings).
 * `name` is reconstructed from first_name / last_name when available.
 */
export function pgToLegacy(row) {
  if (!row) return null;
  const out = { ...row };
  // Timestamps: PG returns Date objects; tests expect ISO strings
  if (out.created_at instanceof Date) {
    out.createdAt = out.created_at.toISOString();
  } else if (out.created_at) {
    out.createdAt = String(out.created_at);
  }
  if (out.updated_at instanceof Date) {
    out.updatedAt = out.updated_at.toISOString();
  } else if (out.updated_at) {
    out.updatedAt = String(out.updated_at);
  }
  delete out.created_at;
  delete out.updated_at;
  // Reconstruct `name` from first_name / last_name for backward compat
  if (out.first_name !== undefined || out.last_name !== undefined) {
    const parts = [out.first_name, out.last_name].filter(Boolean);
    out.name = parts.join(" ") || out.first_name || "";
  }
  return out;
}

/**
 * Convert an incoming legacy request body → PG repository input.
 * Splits `name` into first_name / last_name; copies other fields through.
 */
export function legacyToPg(body) {
  const out = { ...body };
  if ("name" in out) {
    const parts = String(out.name || "").trim().split(/\s+/);
    out.first_name = parts[0] || "";
    out.last_name = parts.slice(1).join(" ") || undefined;
    delete out.name;
  }
  // Drop camelCase timestamp fields if accidentally sent in body
  delete out.createdAt;
  delete out.updatedAt;
  return out;
}

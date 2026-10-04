/**
 * Serialize a value for a jsonb parameter.
 *
 * node-postgres treats a JS array as a Postgres array literal, not as JSON, so
 * binding `[1, 2]` to a jsonb column produces `"{1,2}"` and the server rejects
 * it with 22P02 "invalid input syntax for type json". Plain objects do not have
 * this problem because the driver already stringifies them.
 *
 * Every jsonb column that can hold a list (items on quotes/orders/invoices) has
 * to go through here. Already-serialized strings are passed through so a caller
 * that did its own JSON.stringify is not double-encoded.
 */
export function toJsonb(value, fallback) {
  const resolved = value === undefined || value === null ? fallback : value;
  if (resolved === undefined || resolved === null) return null;
  if (typeof resolved === "string") return resolved;
  return JSON.stringify(resolved);
}

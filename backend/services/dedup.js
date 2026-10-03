// Fuzzy duplicate detection.
//
// The existing /api/duplicates route answers a narrower question - "do these two
// rows share a key?" - by grouping on the email local part and, for companies,
// a Fuse bitap name match. That is enough to catch an exact re-import and not
// enough to catch the duplicates a rep actually has to clean up: "Jonathon
// Smith" vs "Jonathan Smith", "Sarah Connor" vs "Sara Conner", a phone with two
// digits transposed. This module scores every pair with a weighted blend of
// exact-match and string-distance signals and reports the ones that clear a
// confidence threshold, with the per-field breakdown so a human can see *why*
// a pair surfaced.
//
// Scoring formula
// ---------------
//   confidence = SUM(weight_i * metric_i) / SUM(weight_i for i with data)
//
//   email   0.40   exact normalized address -> 1.0; same mailbox domain with a
//                  prefix-compatible or near-identical local part -> 0.5;
//                  otherwise proportional to the string distance.
//   name    0.35   string distance over the normalized full name (Jaro-Winkler
//                  blended with trigram overlap), also comparing the tokens in
//                  sorted order so "Smith Sarah" == "Sarah Smith".
//   phone   0.15   normalized digits; equal -> 1.0, same digits permuted
//                  (transposition) -> 0.75, otherwise 0.
//   company 0.10   company name (or, for contacts, the email domain) compared
//                  the same way; any exact hit -> 1.0.
//
// The weights are the spec's. The *denominator* is not always 1.0: a metric
// with no value on either side ("this record has no phone number") carries no
// information, so its weight is redistributed over the metrics that do have
// data instead of being scored as a zero. Without that, a companies pair - which
// has no email and no phone - could not reach 0.65 on any name similarity and
// the resource would be permanently silent. When all four metrics have data the
// denominator is 1.0 and this is exactly SUM(weight_i * metric_i).
//
// Two guards keep the redistribution from inventing confidence:
//   * a pair needs at least MIN_SIGNALS metrics with data, unless the two share
//     an exact email address, which identifies a person on its own. Two
//     different "John Smith" rows that carry nothing but a name are not a pair.
//   * an exact email match caps nothing - it is the strongest signal available -
//     so it is scored, not gated.
//
// String distance is computed in memory. `pg_trgm` is used, when installed, to
// shortlist candidate pairs on very large tables (see trgmShortlist) but never
// to *score* them, so a deployment with or without the extension produces
// identical confidences.

import { query } from "../db/pg.js";
import { readDb } from "../store.js";
import { repoFor } from "../db/repositories/index.js";
import { PG_RESOURCES, pgToLegacy } from "../db/legacy-shape.js";

/** Resources this engine can score, and the fields each one carries. */
export const DEDUP_RESOURCES = new Set(["contacts", "companies", "leads"]);

/** Field weights. Must sum to 1. */
export const WEIGHTS = Object.freeze({
  email: 0.4,
  name: 0.35,
  phone: 0.15,
  company: 0.1,
});

/** A field counts as "matched" for matchedFields at or above this score. */
const MATCHED_FIELD_FLOOR = 0.5;

/** Minimum number of metrics with data before a pair is reportable at all. */
const MIN_SIGNALS = 2;

/** Local parts are compared exactly; anything shorter carries no signal. */
const MIN_PHONE_DIGITS = 7;

/**
 * Above this many rows the full O(n^2) sweep is replaced by a shortlist. 400 is
 * ~80k scored pairs, which is already more than any single screen of results
 * needs; past it the scan has to be blocked, exactly as pg_trgm would block it.
 */
const MAX_PAIRWISE_ROWS = Number(process.env.DEDUP_MAX_PAIRWISE_ROWS || 400);

/** Hard stop on how many rows one detection call will consider. */
const MAX_CANDIDATE_ROWS = Number(process.env.DEDUP_MAX_CANDIDATE_ROWS || 2000);

/** Trigram floor for the SQL prefilter. Deliberately loose: it must never drop a pair a scoring pass would accept. */
const TRGM_PREFILTER = 0.2;

const round = (value, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Lowercased and trimmed. Deliberately laxer than helpers.normalizeEmail. */
export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function splitEmail(email) {
  const at = email.lastIndexOf("@");
  if (at < 1) return { local: email, domain: "" };
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

/**
 * Digits only, with the country code removed.
 *
 * `+1 (415) 555-0100` and `4155550100` have to land on the same string or every
 * comparison of two correctly-formatted numbers reads as "no match". A leading
 * `00` or `1` is dropped past 10 digits, and anything longer than that is
 * compared on its last 10 - a best effort for international formats the schema
 * does not normalize.
 */
export function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  let rest = digits;
  if (rest.length > 10 && rest.startsWith("00")) rest = rest.slice(2);
  if (rest.length > 10 && rest.startsWith("1")) rest = rest.slice(1);
  return rest.length > 10 ? rest.slice(-10) : rest;
}

// ---------------------------------------------------------------------------
// String distance
// ---------------------------------------------------------------------------

/** Classic edit distance on two short strings (names, local parts, domains). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Jaro-Winkler: character-overlap similarity with a bonus for a shared prefix.
 *
 * Preferred over raw Levenshtein for names because "Jonathon" vs "Jonathan" is
 * an insertion in the middle - edit distance scores that 0.89 while Jaro-Winkler
 * scores it 0.96, which is the difference between clearing a 0.9 cutoff and not.
 */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Sørensen-Dice coefficient over character trigrams. */
export function trigramSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const grams = (value) => {
    const padded = `  ${value} `;
    const counts = new Map();
    for (let i = 0; i < padded.length - 2; i++) {
      const gram = padded.slice(i, i + 3);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    return counts;
  };
  const left = grams(a);
  const right = grams(b);
  let intersection = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const [gram, count] of right) {
    total += count;
    intersection += Math.min(count, left.get(gram) || 0);
  }
  return total === 0 ? 0 : (2 * intersection) / total;
}

/**
 * Blended similarity in [0,1].
 *
 * Jaro-Winkler wins on longer strings and trigram overlap wins on short ones
 * ("Jon" vs "Jonn"), so the score is the better of the two. Taking the max
 * rather than the mean keeps a single strong signal from being averaged into
 * invisibility.
 */
export function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(jaroWinkler(a, b), trigramSimilarity(a, b));
}

// ---------------------------------------------------------------------------
// Field metrics
// ---------------------------------------------------------------------------

/**
 * True when one local part is an abbreviation of the other: `s.connor` and
 * `sarah.connor` share every token after the first, and the first tokens are
 * each other's prefix. That is how people actually write addresses when a form
 * asks for initials, and it is the shape the plain `startsWith` check misses in
 * the "abbreviated" direction.
 */
export function isAbbreviatedLocal(localA, localB) {
  const [firstA, ...restA] = localA.split(".");
  const [firstB, ...restB] = localB.split(".");
  if (restA.length === 0 || restB.length === 0) return false;
  if (restA.join(".") !== restB.join(".")) return false;
  return firstA.startsWith(firstB) || firstB.startsWith(firstA);
}

/**
 * Exact address -> 1.0.
 * Same mailbox domain with a prefix-compatible, abbreviated or near-identical
 * local part -> 0.5: same organization, likely the same person, not certain
 * enough to call. Anything else is proportional to the distance between the
 * whole addresses, so a one-character typo in the domain still earns credit.
 */
export function emailMetric(a, b) {
  if (!a || !b) return { score: 0, available: false, exact: false };

  // Casing has to go before the comparison, not after it: "Sarah.Connor@Acme.com"
  // and "sarah.connor@acme.com" are one mailbox, and comparing the raw strings
  // would report a same-domain near-miss instead of the exact hit it is.
  const leftAddress = normalizeEmail(a);
  const rightAddress = normalizeEmail(b);
  if (leftAddress === rightAddress) return { score: 1, available: true, exact: true };

  const left = splitEmail(leftAddress);
  const right = splitEmail(rightAddress);
  const localSimilarity = stringSimilarity(normalizeText(left.local), normalizeText(right.local));
  if (
    left.domain === right.domain &&
    (left.local.startsWith(right.local) ||
      right.local.startsWith(left.local) ||
      isAbbreviatedLocal(left.local, right.local) ||
      localSimilarity >= 0.92)
  ) {
    return { score: 0.5, available: true, exact: false };
  }
  return {
    score: round(0.5 * stringSimilarity(normalizeText(leftAddress), normalizeText(rightAddress))),
    available: true,
    exact: false,
  };
}

/** Full-name similarity, also comparing tokens in sorted order. */
export function nameMetric(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return { score: 0, available: false };
  const direct = stringSimilarity(left, right);
  const reordered = stringSimilarity([...left.split(" ")].sort().join(" "), [...right.split(" ")].sort().join(" "));
  return { score: round(Math.max(direct, reordered)), available: true };
}

/**
 * Normalized-digit comparison.
 *
 * Equal digits -> 1.0. Same length, same multiset of digits in a different
 * order -> 0.75: a transposition is the single most common way a rep retypes a
 * number, and treating it as "no match at all" loses a real duplicate.
 */
export function phoneMetric(a, b) {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (!left || !right) return { score: 0, available: false };
  if (left === right) return { score: 1, available: true };
  if (
    left.length >= MIN_PHONE_DIGITS &&
    left.length === right.length &&
    [...left].sort().join("") === [...right].sort().join("")
  ) {
    return { score: 0.75, available: true };
  }
  return { score: 0, available: true };
}

/**
 * Company similarity over every company-ish value a record has.
 *
 * A contact carries no company column value - only its email domain - so the
 * domain is one of the candidates. For the companies resource the record's own
 * name is its company identity, and it is the only candidate there.
 */
export function companyMetric(candidatesA, candidatesB) {
  const left = candidatesA.filter(Boolean);
  const right = candidatesB.filter(Boolean);
  if (left.length === 0 || right.length === 0) return { score: 0, available: false };
  if (left.some((value) => right.includes(value))) return { score: 1, available: true };
  let best = 0;
  for (const a of left) {
    for (const b of right) best = Math.max(best, stringSimilarity(a, b));
  }
  return { score: round(best), available: true };
}

/**
 * Weighted blend over the metrics that had data.
 *
 * Returns `confidence` in [0,1] plus the per-field `breakdown` (raw metric
 * values, always all four so a caller can see why a field scored zero) and the
 * number of contributing `signals`.
 */
export function combineMetrics(metrics) {
  let available = 0;
  for (const field of Object.keys(WEIGHTS)) {
    if (metrics[field].available) available += WEIGHTS[field];
  }

  let weighted = 0;
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    if (metrics[field].available) weighted += weight * metrics[field].score;
  }

  const breakdown = {};
  for (const field of Object.keys(WEIGHTS)) breakdown[field] = round(metrics[field].score);

  const matchedFields = Object.keys(WEIGHTS)
    .filter((field) => metrics[field].score >= MATCHED_FIELD_FLOOR)
    // Strongest evidence first; a tie goes to the heavier weight, so an exact
    // email is reported ahead of an exact phone.
    .sort((a, b) => metrics[b].score - metrics[a].score || WEIGHTS[b] - WEIGHTS[a]);

  const signals = Object.keys(WEIGHTS).filter((field) => metrics[field].available).length;

  return {
    confidence: available === 0 ? 0 : round(weighted / available),
    breakdown,
    matchedFields,
    signals,
    exactEmail: Boolean(metrics.email.exact),
  };
}

// ---------------------------------------------------------------------------
// Record shaping
// ---------------------------------------------------------------------------

/** The values this resource can be scored on, in the legacy flat shape. */
function candidatesOf(record, resource) {
  const email = normalizeEmail(record.email);
  const domain = email ? splitEmail(email).domain : "";
  // A contact carries no company value of its own, only its email domain. A
  // company record *is* its name, so the name is its company candidate.
  const explicit = (
    resource === "companies"
      ? [record.name, record.domain]
      : [record.company, record.company_name, record.companyName]
  )
    .map(normalizeText)
    .filter(Boolean);
  return {
    id: String(record.id),
    name: record.name || "",
    email,
    phone: record.phone || "",
    company: explicit[0] || null,
    companyValues: [...new Set([...explicit, domain].filter(Boolean))],
    // Sort key: the older record is the one a rep keeps, so it becomes the
    // primary of the reported pair regardless of insertion order.
    createdAt: record.createdAt ? Date.parse(record.createdAt) || 0 : 0,
  };
}

function presentable(candidate) {
  return {
    id: candidate.id,
    name: candidate.name || null,
    email: candidate.email || null,
    phone: candidate.phone || null,
    company: candidate.company || null,
  };
}

function scorePair(a, b) {
  const metrics = {
    email: emailMetric(a.email, b.email),
    name: nameMetric(a.name, b.name),
    phone: phoneMetric(a.phone, b.phone),
    company: companyMetric(a.companyValues, b.companyValues),
  };
  const combined = combineMetrics(metrics);
  // Two rows agreeing on nothing but a name are two people who happen to share
  // one, so a pair has to carry at least MIN_SIGNALS comparisons to be
  // reportable. An exact email is the exception: it identifies a person on its
  // own.
  if (!combined.exactEmail && combined.signals < MIN_SIGNALS) return null;
  if (combined.confidence <= 0) return null;
  return combined;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

/** Per-resource table + column knowledge, used only by the pg_trgm prefilter. */
const RESOURCE_COLUMNS = {
  contacts: { table: "contacts", name: "first_name", lastName: "last_name", email: "email", company: null },
  companies: { table: "companies", name: "name", lastName: null, email: null, company: "domain" },
  leads: { table: "leads", name: "first_name", lastName: "last_name", email: "email", company: "company_name" },
};

/** Process-lifetime cache for one-off environment probes. */
const pgReachable = new Map();

/** Cached per process: the extension's presence does not change at runtime. */
async function hasPgTrgm() {
  if (!pgReachable.has("trgm")) {
    try {
      const result = await query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS present",
      );
      pgReachable.set("trgm", Boolean(result.rows[0]?.present));
    } catch {
      pgReachable.set("trgm", false);
    }
  }
  return pgReachable.get("trgm");
}

/**
 * Shortlist candidate pairs with pg_trgm, for tables too large to score pairwise.
 *
 * The predicate is the union of "trigram distance says these strings are close"
 * and "they share an exact normalized value" over every comparable column.
 * Exact equality is included because two byte-identical short strings can still
 * score poorly on trigrams (few trigrams to compare), and dropping those would
 * hide the most obvious duplicate of all. Columns this resource does not have
 * are left out of the union entirely rather than compared as '' - an empty
 * string equals another empty string, which would shortlist the whole table.
 */
async function trgmShortlist(table, workspaceId, columns) {
  if (!(await hasPgTrgm())) return null;

  const nameOf = (alias) => {
    if (!columns.name) return null;
    const parts = [columns.name, columns.lastName].filter(Boolean);
    return parts.length === 1 ? `${alias}.${parts[0]}` : `COALESCE(${alias}.${parts[0]}, '') || ' ' || COALESCE(${alias}.${parts[1]}, '')`;
  };
  const predicates = [];
  for (const [expression, raw] of [
    [nameOf("a"), columns.name],
    [columns.email ? "a." + columns.email : null, columns.email],
    [columns.company ? "a." + columns.company : null, columns.company],
  ]) {
    if (!expression || !raw) continue;
    const mirror = raw === columns.name ? nameOf("b") : expression.replace(/\ba\./, "b.");
    predicates.push(`similarity(${expression}, ${mirror}) > $2`);
    predicates.push(`LOWER(COALESCE(${expression}, '')) = LOWER(COALESCE(${mirror}, ''))`);
  }
  if (predicates.length === 0) return null;

  const result = await query(
    `SELECT DISTINCT a.id AS primary_id, b.id AS candidate_id
       FROM ${table} a
       JOIN ${table} b
         ON a.id < b.id
        AND a.workspace_id = $1
        AND b.workspace_id = $1
      WHERE ${predicates.join("\n         OR ")}`,
    [workspaceId, TRGM_PREFILTER],
  );
  return result.rows.map((row) => [row.primary_id, row.candidate_id]);
}

/** Blocking keys for the no-pg_trgm path: cheap and deliberately generous. */
function blockingKeys(candidate) {
  return [
    candidate.email,
    normalizePhone(candidate.phone),
    candidate.name ? normalizeText(candidate.name).split(" ").slice(-1)[0] : "",
    candidate.companyValues[0] || "",
  ].filter((key) => key && key.length >= 3);
}

/**
 * Every index pair worth scoring.
 *
 * Small tables are scored exhaustively - that is what the endpoint's contract
 * promises and it keeps the behaviour identical whatever the table size. Large
 * ones fall back to pg_trgm, or to an in-memory blocking-key shortlist when the
 * extension is absent. Past the cap the caller is told the answer is partial
 * rather than being handed a silently truncated one.
 */
async function candidatePairs(resource, candidates, workspaceId) {
  if (candidates.length < 2) return { pairs: [], exhaustive: true };

  if (candidates.length <= MAX_PAIRWISE_ROWS) {
    const pairs = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) pairs.push([candidates[i].id, candidates[j].id]);
    }
    return { pairs, exhaustive: true };
  }

  const spec = RESOURCE_COLUMNS[resource];
  const shortlist = spec ? await trgmShortlist(spec.table, workspaceId, spec) : null;
  if (shortlist) return { pairs: shortlist, exhaustive: false };

  const buckets = new Map();
  for (const candidate of candidates) {
    for (const key of blockingKeys(candidate)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(candidate.id);
    }
  }
  const seen = new Set();
  const pairs = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const [a, b] = [bucket[i], bucket[j]].sort();
        const key = `${a}\u0000${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }
  return { pairs, exhaustive: false };
}

async function loadFromPostgres(resource, workspaceId) {
  const repo = repoFor(resource);
  const rows = [];
  // findAll() caps a page at 100 rows. Stopping after one page would silently
  // hide every duplicate beyond it, which is the opposite of the point.
  for (let page = 1; ; page++) {
    const result = await repo.findAll({ page, limit: 100, workspaceId });
    rows.push(...result.data.map((row) => pgToLegacy(row, resource)));
    if (result.data.length === 0 || rows.length >= result.total) break;
    if (rows.length >= MAX_CANDIDATE_ROWS) break;
  }
  return rows;
}

async function loadRows(resource, workspaceId) {
  if (!PG_RESOURCES.has(resource)) {
    const db = await readDb();
    return db[resource] || [];
  }
  try {
    return await loadFromPostgres(resource, workspaceId);
  } catch (error) {
    // Detection is read-only, so degrading to the JSON store is safe where
    // degrading a merge is not. A connection-level failure is the only case
    // where the JSON store can be the fresher answer; anything else (a missing
    // table, a bad column) is a real fault and propagates.
    const connectionLevel = ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "57P03"];
    if (!connectionLevel.includes(error.code)) throw error;
    const db = await readDb();
    return db[resource] || [];
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Score every candidate pair in a resource and report the pairs that look like
 * the same entity, strongest first.
 *
 * Returns the ranked pairs plus `scanned` (rows considered) and `exhaustive`
 * (false when a prefilter narrowed the search, which only happens past
 * MAX_PAIRWISE_ROWS rows).
 */
export async function findDuplicateScan({
  resource = "contacts",
  workspaceId = "default",
  threshold = 0.65,
  limit = 50,
} = {}) {
  if (!DEDUP_RESOURCES.has(resource)) {
    throw new Error(`resource must be one of: ${[...DEDUP_RESOURCES].join(", ")}`);
  }
  const minConfidence = Math.min(Math.max(Number(threshold) || 0, 0), 1);
  const maxResults = Math.min(Math.max(Number(limit) || 1, 1), 500);

  const rows = await loadRows(resource, workspaceId);
  const candidates = rows.map((row) => candidatesOf(row, resource)).slice(0, MAX_CANDIDATE_ROWS);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const { pairs, exhaustive } = await candidatePairs(resource, candidates, workspaceId);

  const results = [];
  for (const [idA, idB] of pairs) {
    const a = byId.get(String(idA));
    const b = byId.get(String(idB));
    if (!a || !b) continue;
    const scored = scorePair(a, b);
    if (!scored || scored.confidence < minConfidence) continue;
    // Older record keeps the pair's primary slot; id breaks a created_at tie so
    // the output is stable across runs.
    const [primary, candidate] =
      a.createdAt === b.createdAt
        ? a.id <= b.id
          ? [a, b]
          : [b, a]
        : a.createdAt < b.createdAt
          ? [a, b]
          : [b, a];
    results.push({
      primary: presentable(primary),
      candidate: presentable(candidate),
      confidence: scored.confidence,
      matchedFields: scored.matchedFields,
      breakdown: scored.breakdown,
    });
  }

  results.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.primary.id.localeCompare(right.primary.id) ||
      left.candidate.id.localeCompare(right.candidate.id),
  );

  return {
    duplicates: results.slice(0, maxResults),
    exhaustive,
    scanned: candidates.length,
    scoredPairs: pairs.length,
  };
}

/**
 * @param {object}   options
 * @param {string}   [options.resource]     contacts | companies | leads
 * @param {string}   [options.workspaceId]  tenant to score within; rows from any
 *                                          other tenant are never loaded, so the
 *                                          result cannot contain them
 * @param {number}   [options.threshold]    minimum confidence, [0,1]
 * @param {number}   [options.limit]        maximum pairs returned
 * @returns {Promise<Array<{primary, candidate, confidence, matchedFields, breakdown}>>}
 */
export async function findDuplicates(options = {}) {
  return (await findDuplicateScan(options)).duplicates;
}

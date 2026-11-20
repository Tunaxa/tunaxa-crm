# List Query Parameters

**Status:** canonical reference for the shared list-query defences (P2-BE1-02).

The normalization helpers live in
[`backend/middleware/pagination.js`](../backend/middleware/pagination.js). They
are applied to every list request by a global Express guard in
`backend/server.js`, and the JSON-store `paginateAndSort()` helper uses the same
rules when sorting in memory.

## Request parameters

| Parameter | Type | Constraints | Default | Notes |
| --- | --- | --- | --- | --- |
| `page` | integer | `>= 1` | `1` | Values below `1` or non-numeric values fall back to `1`. |
| `limit` | integer | `1..100` | `25` | Values above `100` clamp to `100`; invalid or `< 1` values fall back to `25`. |
| `sortBy` | string | single safe identifier | `createdAt` | Letters/digits/underscore only. `__proto__`, `constructor`, `prototype`, dotted paths and punctuation are replaced with the default. |
| `sortDir` | string | `asc` \| `desc` (case-insensitive) | `desc` | `order` is accepted as an alias. Anything else falls back to `desc`. |
| `q` | string | free text | — | `search` is accepted as an alias where supported. |

### Repeated parameters are a 400

List controls must be single values. Repeating them, or using array notation,
is rejected with `400 Bad Request` rather than silently coerced:

```http
GET /api/leads?page[]=1          -> 400
GET /api/leads?page=1&page=2     -> 400
GET /api/leads?sortBy[]=name     -> 400
```

The guard covers `page`, `limit`, `sortBy`, `sortDir`/`order` and
`q`/`search`. Other query parameters are unaffected.

### Accepted value forms

- `page`, `limit`: decimal integer strings (`?page=2&limit=25`). Fractional
  values are truncated toward zero.
- `sortDir` is case-insensitive: `ASC`, `Asc` and `asc` are equivalent.
- `sortBy` also accepts the legacy `field:direction` spelling
  (`?sortBy=created_at:asc`). An explicit `sortDir`/`order` wins over the inline
  direction.

## Response shape

Dev's list endpoints already return a uniform envelope; this work does **not**
introduce an opt-in mode or change that contract:

```json
{
  "data": [ { "id": "lead_123", "name": "Acme Corp" } ],
  "total": 137,
  "page": 1,
  "limit": 25
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `data` | array | The records for the requested page. |
| `total` | integer | Total matching records across all pages. |
| `page` | integer | Echo of the normalized page (always `>= 1`). |
| `limit` | integer | Echo of the normalized page size (`1..100`, default `25`). |

`buildPaginationEnvelope()` additionally exposes `totalPages` (`ceil(total /
limit)`, `0` when empty) for callers that want it; existing routes keep their
four-key shape unchanged.

## Sorting

- Postgres-backed resources keep their own per-resource column allow-list and
  translate `sortBy`/`sortDir` into `<column>:<direction>` form, so an unknown
  field degrades to the repository default without reaching SQL.
- JSON-backed resources sort in memory. `sortRecords()` and `paginateAndSort()`
  only accept a single safe field identifier, putting missing/`null` values
  last in both directions and keeping the input order for ties.

## Examples

```http
GET /api/leads?page=2&limit=25&sortBy=createdAt&sortDir=asc
GET /api/quotes?limit=100
GET /api/pipeline-definitions?sortBy=name&sortDir=asc
GET /api/forms?page=1&limit=50
```

# List Query Parameters

**Status:** canonical reference for every collection endpoint (P2-BE1-02).

All list endpoints share one query-parameter contract. The normalization lives in
[`backend/middleware/pagination.js`](../backend/middleware/pagination.js) and is
applied by the generic resource router (`GET /api/:resource`) as well as the
dedicated list routes.

## Request parameters

| Parameter | Type | Constraints | Default | Notes |
| --- | --- | --- | --- | --- |
| `page` | integer | `>= 1` | `1` | Invalid, zero, negative or non-numeric values are clamped to the default. |
| `limit` | integer | `1..100` | `20` | Values above `100` are clamped to `100`; invalid or `< 1` values fall back to the default. |
| `sortBy` | string | single field identifier | `createdAt` | Letters/digits/underscore only. `__proto__`, `constructor` and `prototype` are rejected, as are dotted paths and whitespace. |
| `sortDir` | string | `asc` \| `desc` (case-insensitive) | `desc` | Anything else falls back to `desc`. |
| `envelope` | boolean | `true` \| `1` \| `yes` | unset | Opt in to the paged response envelope (see below). |
| `q` | string | free text | — | Resource-specific search filter where supported. |

### Accepted value forms

- `page`, `limit`: decimal integer strings (`?page=2&limit=25`). Repeated query
  parameters (`?limit=1&limit=2`, which arrive as an array) are ignored in
  favour of the default rather than coerced.
- `sortDir` is case-insensitive: `ASC`, `Asc` and `asc` are equivalent.
- `sortBy` also accepts the legacy `field:direction` spelling
  (`?sortBy=created_at:asc`). When both are supplied, an explicit `sortDir`
  wins over the inline direction.
- `envelope` accepts `true`, `1` or `yes`; any other value (including `false`)
  is treated as "off".

## Response shapes

### Legacy array (default)

For backward compatibility, the generic resource router and the pipeline
definition list return a **bare JSON array** when `envelope` is not set:

```json
[ { "id": "lead_123", "name": "Acme Corp", "createdAt": "2026-01-01T00:00:00.000Z" } ]
```

Resources that already expose a paged object (`/api/forms`,
`/api/workflows/:id/runs`) keep their `{ data, total, ... }` shape unconditionally.

### Uniform envelope (`?envelope=true`)

When the caller opts in, the response is:

```json
{
  "data": [ { "id": "lead_123", "name": "Acme Corp" } ],
  "page": 1,
  "limit": 20,
  "total": 137,
  "totalPages": 7
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `data` | array | The records for the requested page. |
| `page` | integer | Echo of the normalized page (always `>= 1`). |
| `limit` | integer | Echo of the normalized page size (`1..100`). |
| `total` | integer | Total matching records across all pages. |
| `totalPages` | integer | `ceil(total / limit)`; `0` when there are no matches. |

### Messages resource

`GET /api/messages` keeps its own paged shape when `page`/`limit` are supplied,
preserving the keys existing clients consume while adding the shared
`totalPages` metadata:

```json
{
  "items": [ { "id": "msg_1" } ],
  "total": 42,
  "page": 1,
  "limit": 20,
  "totalPages": 3,
  "hasMore": true
}
```

## Sorting

- Postgres-backed resources translate `sortBy` (camelCase) and `sortDir` into the
  `<column>:<direction>` form their repository expects, e.g.
  `?sortBy=createdAt&sortDir=asc` becomes `created_at:asc`. Unknown fields
  degrade to the repository default (`created_at DESC`) because each repository
  keeps its own column allow-list.
- JSON-backed resources are sorted in memory only when `sortBy` or `sortDir` is
  explicitly supplied; a bare list keeps its stored order. Missing/`null`
  values sort last regardless of direction.

## Examples

```http
GET /api/leads?page=2&limit=25&sortBy=createdAt&sortDir=asc&envelope=true
GET /api/quotes?envelope=true&limit=100
GET /api/pipeline/definitions?sortBy=name&sortDir=asc
GET /api/forms?page=1&limit=50
```

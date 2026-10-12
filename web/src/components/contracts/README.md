# Contract detail data

The existing contracts table links to `/contracts/:id`. The shared detail page
uses `GET /api/contracts/:id`, saves summary fields with
`PUT /api/contracts/:id`, and loads the timeline with
`GET /api/activities?recordId=:id`. No backend endpoint is added.

Summary fields use the existing contract schema: name, customer, value, mrr,
billingFrequency, startDate, endDate, autoRenew, and status. Summary edits do not
send signature metadata or quote references. The existing PUT endpoint merges
the supplied summary fields into the stored record.

Optional quote reference: `quoteId` (record ID), `quoteNumber` (display label).
The link uses the ID, never a quote number or customer-name match.

The following optional signature shape is a frontend integration contract,
pending confirmation from the backend owner. It is not a claim that signature
capture/persistence has already been implemented:

```json
{
  "signature": {
    "signerName": "Alice",
    "signerEmail": "alice@example.com",
    "signerIp": "192.0.2.1",
    "signedAt": "2026-09-27T10:00:00Z",
    "imageDataUrl": "data:image/png;base64,..."
  }
}
```

AXA-136 already emits imageDataUrl, signedAt and typedName. A persisted typedName
can be displayed when signerName is absent. The UI never infers signer email or
IP, creates a timestamp, captures a new signature, or asserts legal validity.
Missing or malformed metadata is shown as unavailable. Images support the
modal's PNG/SVG data URLs and local `/uploads/` paths; external URLs need an
agreed backend asset contract before support is added.

The backend must supply the original quote reference and recorded signature
metadata for those panels to be populated. IP should come from the backend's
signing event, not from browser-generated information.

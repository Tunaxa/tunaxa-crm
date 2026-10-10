# Multi-pipeline builder

Implements AXA-294 on `feat/multi-pipeline-builder`. The board supports creating and editing pipeline names, stages, order and win probabilities, switching pipelines, and creating or moving deals within the selected pipeline. The last pipeline selection is stored locally. Existing record forms, CSV import and page primitives remain in use.

## Backend contract and merge order

Definition management depends on backend PR [#461](https://github.com/Tunaxa/tunaxa-crm/pull/461). Its inspected head was `9cfc07f14ab82754459462e3ff13b01f97d7c2ea`:

- `GET /api/pipeline/definitions`: array of definitions.
- `POST /api/pipeline/definitions`: create with `{ name, stages }`.
- `PUT /api/pipeline/definitions/:id`: update with `{ name, stages }`.
- A definition has `{ id, name, stages }`; each stage has `{ key, label, probability, order }`.
- Deals use the existing `POST /api/deals` and `PUT /api/deals/:id`, sending `pipelineId`, the stable stage key and its configured probability. The old single-pipeline move route is not used for custom stages.

This branch includes the Sales/Marketing extraction and CSV wizard predecessors. Merge frontend PR #475, then #476, before this PR to keep its final diff focused. Backend #461 must also land before definition creation/editing can work. Its backend owner should verify `deals.pipeline_id` on existing installations as described in that PR. This frontend change neither introduces nor applies a schema migration and does not alter production backend code.

## Compatibility and editing rules

- A 404 from the definitions endpoint shows an availability notice and retains the legacy board. Other API errors retain cached records but disable writes until resolved.
- The first returned definition is the primary pipeline. Legacy deals without a pipeline binding appear there; explicit unknown bindings appear in an Unassigned pipeline view.
- Unknown stages remain visible in an Unmapped stages lane.
- Renaming or reordering preserves stage keys. Occupied stages cannot be removed. Old rows stored by stage label must be moved out and back into their stage before changing that label.
- A stage probability must be a finite number between 0 and 100. New deals and stage moves save the configured probability; changing a stage definition does not rewrite existing deals' saved probabilities.
- CSV import accepts stage keys or displayed labels and binds all rows to its selected destination. The destination stays locked while the wizard is open; background deal refreshes do not stop an import.
- Admin/member roles can configure and edit; viewers retain read-only access. Pipeline deletion is outside this task.
- The occupied-stage guard uses the currently loaded deal list. Concurrent server-side changes still require backend validation; this UI does not claim atomic protection against another user's simultaneous edits.

## Verification

- Full suite: 73 files / 1,042 tests passed against a new isolated local PostgreSQL database using existing migrations.
- After the final import-lock adjustment: 73 relevant UI, module parity and CSV tests passed again.
- TypeScript and repository ESLint passed.
- A permanent integration test verifies frontend deal payloads against the existing deal API, including pipeline separation and probability persistence.
- A temporary isolated harness also passed against the exact pending #461 definition route, covering create, rename, stable keys, probability, primary fallback and deal separation. This is a compatibility check, not proof that #461 is deployed or merged.
- Tests used a temporary native TypeScript transform because this machine blocks esbuild child-process spawning. The standard production build remains blocked by `spawn EPERM`. Browser interaction and production build validation remain required.

## Browser acceptance checks after backend merge

1. As a member, create two pipelines with different stages and probabilities. Refresh; verify both definitions and the last selection persist.
2. Add deals to both. Switch boards and verify each pipeline's cards, counts and values are separate.
3. Move a deal using drag/drop and its stage select, then refresh and verify its stage and probability persist.
4. Rename and reorder a key-linked occupied stage; verify its deals remain. Attempt to remove it and confirm the control is disabled.
5. Import a CSV using displayed stage names, plus a row with an invalid stage. Verify the fixed destination, accepted rows and error report. A background refresh must not interrupt the import.
6. Open a viewer session; verify configuration, deal mutation and import are unavailable.
7. Check a server without the definitions endpoint, an API error, an unknown stage and an unavailable pipeline binding. Existing records must stay visible with an accurate notice.

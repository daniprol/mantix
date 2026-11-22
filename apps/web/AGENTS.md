# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: false

## Project Notes

The Mantix dashboard. It talks to the Mantix server through the shared
`MantixApi` contract in `packages/api` (typed client in `src/api.ts`).

- `pnpm --filter @mantix/web mock` starts a fake server on :4100 (runs last
  60 s; `MOCK_DURATION`, `MOCK_LAG=0`). `pnpm dev` proxies `/api` to it.
- Layout: `model.ts`, `message.ts`, `update.ts`, `commands.ts`,
  `subscriptions.ts`, `view/*`, pure helpers in `domain/*`, charts in
  `charts/*`. `route.ts` holds the URLs, and `analysis.ts` works out what
  the run, endpoint and comparison pages show from the Model.
- Pages are routes, so browser back and reload work: `/` (New run),
  `/runs`, `/runs/:id`, `/runs/:id/endpoints/:endpoint`, `/compare`,
  `/compare/:id/:baselineId` and `/compare/:id/:baselineId/endpoints/:endpoint`.
  The endpoint is one URL-encoded segment ("GET%20%2Fproducts%2F%3Asku").
- Chart objects (uPlot) never go in the Model. `charts/timeline.ts` creates
  them in a Mount and registers them in `charts/store.ts`; the SyncTimeline
  Command hands them data. `update` sends SyncTimeline only when the
  timeline's input changed.
- Percentiles always come from merged histograms (`summarize`), never
  averaged. The headline is p95 (p50 and p95 labels everywhere); fewer than
  20 requests shows no p95.
- The list under the timeline shares its columns with the chart
  (`charts/layout.ts`), so each endpoint's curve lines up with the time axis.
- Design rules: light theme only, tokens in `styles.css`, Geist + Geist
  Mono for numbers, hairlines not cards, amber only for live edge, selection
  and focus, red only for errors and failed checks, one primary button. No
  explanatory titles or sentences: labels and data.
- Tests: `story.test.ts` (update), `scene.test.ts` (view) and
  `e2e/dashboard.spec.ts` (a real browser against `mantix ui`).

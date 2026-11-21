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
  `charts/*`.
- Chart objects (uPlot) never go in the Model. `charts/timeline.ts` creates
  them in a Mount and registers them in `charts/store.ts`; the SyncTimeline
  Command hands them data.
- Percentiles always come from merged histograms (`summarizeSeconds`),
  never averaged. Fewer than 100 requests shows "n<100", not a p99.
- Design rules (proposal §3): tokens in `styles.css`, Geist + Geist Mono
  for numbers, hairlines not cards, amber only for live edge, selection and
  focus, red only for errors and failed thresholds, one primary button.

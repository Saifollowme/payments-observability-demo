# Payments Observability Demo — Phase 1

A live, in-browser prototype of the **Payments Operations Command Centre** and
**Transaction Journey Trace** views described in
`Payments_Observability_Requirements_v0.2`, covering the primary scenario:
fraud & sanctions screening latency degradation on an instant-payment rail.

No backend, no database — a self-contained simulator generates synthetic
payment events and steps them through the journey stages defined in
[`docs/payment_event_schema_v1.md`](docs/payment_event_schema_v1.md).

## Run it locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (typically `http://localhost:5173`).

## Build for deployment

```bash
npm run build
npm run preview   # sanity-check the production build locally
```

`npm run build` outputs static files to `dist/` — deployable to any static
host (GitHub Pages, Netlify, Vercel, S3, etc.).

## What's in scope

- **Scenario:** fraud-screening latency injected into an instant payment's
  journey; payments progress from within-SLA → at risk → critical → timed out.
- **Views:** Payments Operations Command Centre (live pipeline, alert
  progression, incident chronology, at-risk cohort) and Transaction Journey
  Trace (per-payment stage timeline and SLA consumption).
- **Out of scope for this phase:** Executive Payment Health Overview and
  SLA & Operational Resilience dashboards, real platform integration
  (Datadog or otherwise), and any production data.

## Project structure

```
src/
  App.jsx       — the entire simulator + both dashboard views
  main.jsx      — React entry point
docs/
  payment_event_schema_v1.md  — the data model the simulator implements
```

## Status

Illustrative SLA defaults (7s warning / 9s critical / 10s breach) are demo
values pending sign-off — see the requirements doc, decision D-03.

# Payment Event & Data Schema — Phase 1

**Scope:** Fraud-screening latency degradation scenario → feeds *Payments Operations Command Centre* + *Transaction Journey Trace*.
**Traceability:** §3, §7.1–7.7, §8, §9 of `Payments_Observability_Requirements_v0.2`.

---

## 1. Design principles

- **One schema, two consumers.** Every record feeds both dashboards — no dashboard-specific duplication of truth.
- **Four object types, not one blob:**
  - `PaymentEvent` — raw stage-level telemetry (drives the Transaction Journey Trace)
  - `Payment` — current-state aggregate per correlation ID (drives lists/filters on both views)
  - `ServiceAlert` — aggregate service condition (drives the Ops Command Centre)
  - `ScenarioControl` — simulation harness state (drives the demo controls)
- **Terminology discipline (§3.2):** "SLA breach" is a *service-level* alert. A payment's own outcome is recorded separately as `TIMED_OUT` / `REJECTED` — never as "breached." This distinction is what FR-85 and FR-86 require, and it's the single easiest thing to get wrong when building the simulator, so it's enforced at the schema level here rather than left to UI logic.
- **Config-driven thresholds (A-04, A-09).** SLA values live in `SLAProfile`, never hardcoded into event logic.

---

## 2. Enumerations

### 2.1 Layers (§3.3)
`INITIATION` · `ORCHESTRATION` · `EXECUTION_CONTROL` · `CLEARING_SETTLEMENT`

### 2.2 Stages (Phase 1 subset)

| Stage code | Layer | Description |
|---|---|---|
| `CHANNEL_ENTRY` | INITIATION | Payment instruction received from channel |
| `AUTH_VALIDATE` | ORCHESTRATION | Authentication + validation |
| `ENRICH_ROUTE` | ORCHESTRATION | Enrichment + routing decision |
| `FUNDS_CHECK` | EXECUTION_CONTROL | Balance / limits check |
| `FRAUD_SANCTIONS` | EXECUTION_CONTROL | Fraud & sanctions screening — **latency injection point** |
| `EXECUTION_POST` | EXECUTION_CONTROL | Ledger posting |
| `SCHEME_SUBMIT` | CLEARING_SETTLEMENT | Submission to scheme adapter / CSM *(simulated)* |
| `RECEIVING_RESPONSE` | CLEARING_SETTLEMENT | Receiving participant response *(simulated)* |
| `CUSTOMER_NOTIFY` | CLEARING_SETTLEMENT | Final status returned to customer |

### 2.3 Direction (FR-22, §3.3 bidirectional requirement)
`REQUEST` · `RESPONSE` · `STATUS_UPDATE`

### 2.4 Payment lifecycle status
`RECEIVED → VALIDATED → SCREENING → SCREENED → EXECUTING → SUBMITTED → CLEARED → NOTIFIED → COMPLETE`
Terminal, non-progressing: `TIMED_OUT` · `REJECTED` · `FAILED`

### 2.5 SLA risk state (computed continuously, in-flight payments only)
`WITHIN_SLA → AT_RISK → CRITICAL → BREACHED`
(`BREACHED` is the trigger that assigns a terminal outcome — it is a transient computed flag, not itself stored as the final state)

### 2.6 Terminal outcome / disposition
`COMPLETED` · `TIMED_OUT` · `REJECTED` · `FAILED`
Per A-10: terminal is final for the *original* instruction only. A retry gets a new `payment_id` with `retry_of` pointing back to the original (FR-87).

### 2.7 Service alert level (§9.2 — drives the Ops Command Centre)
`WARNING → CRITICAL → BREACH → RECOVERING → CLOSED`

### 2.8 Data provenance (FR-88, A-02)
`OBSERVED` · `SIMULATED` · `INFERRED`

---

## 3. Core object schemas

### 3.1 `PaymentEvent` — stage-level telemetry (Transaction Journey Trace)

```json
{
  "event_id": "evt-000123",
  "payment_id": "DEMO-PMT-00042",
  "message_id": "MSG-556677",
  "instruction_id": "INSTR-9981",
  "trace_id": "trace-abc-123",
  "scenario_id": "SC-FRAUD-LAT-01",
  "layer": "EXECUTION_CONTROL",
  "stage": "FRAUD_SANCTIONS",
  "direction": "REQUEST",
  "source_ts": "2026-08-24T09:12:03.210Z",
  "ingestion_ts": "2026-08-24T09:12:03.240Z",
  "stage_start_ts": "2026-08-24T09:12:03.210Z",
  "stage_end_ts": null,
  "stage_duration_ms": null,
  "rail": "INSTANT_PAY_RAIL_A",
  "sending_bank": "BANK_A",
  "csm": "CSM_SIM_1",
  "receiving_bank": "BANK_B_SIM",
  "amount_band": "1K_10K",
  "currency": "GBP",
  "payment_type": "P2P",
  "priority": "STANDARD",
  "status": "SCREENING",
  "status_reason": null,
  "data_source": "SIMULATED",
  "sequence_flag": "IN_ORDER"
}
```

### 3.2 `Payment` — current-state aggregate (both dashboards)

```json
{
  "payment_id": "DEMO-PMT-00042",
  "scenario_id": "SC-FRAUD-LAT-01",
  "channel": "DIGITAL",
  "rail": "INSTANT_PAY_RAIL_A",
  "amount_band": "1K_10K",
  "currency": "GBP",
  "current_stage": "FRAUD_SANCTIONS",
  "lifecycle_status": "SCREENING",
  "sla_risk_state": "AT_RISK",
  "terminal_outcome": null,
  "terminal_reason": null,
  "accepted_ts": "2026-08-24T09:12:00.000Z",
  "elapsed_ms": 7120,
  "sla_threshold_ms": 10000,
  "remaining_budget_ms": 2880,
  "retry_of": null,
  "is_retry": false,
  "last_updated_ts": "2026-08-24T09:12:07.120Z"
}
```

### 3.3 `ServiceAlert` — aggregate service condition (Ops Command Centre)

```json
{
  "alert_id": "ALRT-0007",
  "scenario_id": "SC-FRAUD-LAT-01",
  "level": "CRITICAL",
  "stage": "FRAUD_SANCTIONS",
  "rail": "INSTANT_PAY_RAIL_A",
  "affected_count": 14,
  "affected_value": 86400.00,
  "oldest_inflight_age_ms": 9340,
  "queue_depth": 22,
  "raised_ts": "2026-08-24T09:12:05.000Z",
  "updated_ts": "2026-08-24T09:12:09.000Z",
  "closed_ts": null,
  "dedup_key": "SC-FRAUD-LAT-01:FRAUD_SANCTIONS:CRITICAL"
}
```

### 3.4 `ScenarioControl` — simulation harness (FR-01–08)

```json
{
  "scenario_id": "SC-FRAUD-LAT-01",
  "state": "DEGRADING",
  "injection": {
    "target_stage": "FRAUD_SANCTIONS",
    "type": "PROGRESSIVE_LATENCY",
    "started_ts": "2026-08-24T09:10:00.000Z",
    "removed_ts": null
  },
  "sla_profile_id": "PROFILE_DEMO_DEFAULT",
  "marker_ts": "2026-08-24T09:12:00.000Z"
}
```
`state` values: `HEALTHY` · `DEGRADING` · `BREACH_ACTIVE` · `RECOVERING` · `STABLE`

### 3.5 `SLAProfile` — configurable thresholds (A-04, A-09, §9.1)

```json
{
  "profile_id": "PROFILE_DEMO_DEFAULT",
  "rail": "INSTANT_PAY_RAIL_A",
  "end_to_end_sla_ms": 10000,
  "warning_threshold_ms": 7000,
  "critical_threshold_ms": 9000,
  "stage_thresholds": { "FRAUD_SANCTIONS": 3000 },
  "is_illustrative_default": true
}
```

---

## 4. Field → dashboard mapping

| Dashboard | Consumes |
|---|---|
| **Ops Command Centre** | `ServiceAlert` (all fields) · `Payment.sla_risk_state` aggregated by stage · `Payment.remaining_budget_ms` (sorted, at-risk cohort) · `ScenarioControl.state` |
| **Transaction Journey Trace** | `PaymentEvent[]` (full ordered list for one `payment_id`) · `Payment` (header/summary) · `SLAProfile` (threshold vs. actual) |

---

## 5. Worked example — one payment through the exception path

Ties directly to the controlled narrative in §3.2:

| Step | `sla_risk_state` | Elapsed | Event |
|---|---|---|---|
| Accepted | `WITHIN_SLA` | 0 ms | `CHANNEL_ENTRY` → `AUTH_VALIDATE` → `FUNDS_CHECK` complete |
| Enters screening | `WITHIN_SLA` | 1,200 ms | `FRAUD_SANCTIONS` request logged |
| Warning threshold crossed | `AT_RISK` | 7,000 ms | Still in `FRAUD_SANCTIONS` — `ServiceAlert` level → `WARNING` |
| Critical threshold crossed | `CRITICAL` | 9,000 ms | `ServiceAlert` level → `CRITICAL` |
| SLA exceeded | `BREACHED` → terminal | 10,000 ms | `Payment.terminal_outcome = "TIMED_OUT"`, does **not** proceed to `SCHEME_SUBMIT` |

Note the payment never shows `sla_risk_state: BREACHED` at rest — it's a one-tick trigger that immediately resolves to a terminal outcome, per the terminology rule in §1 above.

---

## 6. Open items to confirm before building the simulator

- **D-03 (SLA values)** is still open in the source doc — this schema uses the 7/9/10-second illustrative defaults from §9.1 pending confirmation.
- **`stage_thresholds.FRAUD_SANCTIONS`** has no doc-specified demo value — defaulted to 3,000 ms here; flagged as illustrative, same as the top-level SLA values.
- **Channel list** — `CHANNEL_ENTRY.channel` will support `DIGITAL` and `CORPORATE_HOST_TO_HOST` for Phase 1; full multi-channel convergence (AC-13) is a later-phase concern, not required for AC-05/06/07.

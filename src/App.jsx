import { useState, useEffect, useRef } from "react";
import { Play, Pause, RotateCcw, AlertTriangle, CheckCircle2, ArrowLeft } from "lucide-react";

/* ---------------------------------------------------------------
   Domain model — mirrors payment_event_schema_v1.md
--------------------------------------------------------------- */

const STAGES = [
  { code: "CHANNEL_ENTRY", layer: "Initiation", label: "Channel entry", baseMs: 60, owner: "bank", simulated: false, direction: "in" },
  { code: "AUTH_VALIDATE", layer: "Orchestration", label: "Auth & validate", baseMs: 180, owner: "bank", simulated: false, direction: "internal" },
  { code: "ENRICH_ROUTE", layer: "Orchestration", label: "Enrich & route", baseMs: 120, owner: "bank", simulated: false, direction: "internal" },
  { code: "FUNDS_CHECK", layer: "Execution & control", label: "Funds check", baseMs: 220, owner: "bank", simulated: false, direction: "internal" },
  { code: "FRAUD_SANCTIONS", layer: "Execution & control", label: "Fraud & sanctions", baseMs: 820, owner: "bank", simulated: false, direction: "internal" },
  { code: "EXECUTION_POST", layer: "Execution & control", label: "Ledger posting", baseMs: 160, owner: "bank", simulated: false, direction: "internal" },
  { code: "SCHEME_SUBMIT", layer: "Clearing & settlement", label: "Scheme adapter", baseMs: 220, owner: "csm", simulated: true, direction: "out" },
  { code: "RECEIVING_RESPONSE", layer: "Clearing & settlement", label: "Receiving bank", baseMs: 320, owner: "receiving", simulated: true, direction: "in" },
  { code: "CUSTOMER_NOTIFY", layer: "Clearing & settlement", label: "Customer notify", baseMs: 110, owner: "bank", simulated: false, direction: "out" },
];

const SLA = { warning: 7000, critical: 9000, breach: 10000 };
const TICK_REAL_MS = 120;
const TICK_SIM_MS = 120; // 1:1 scale — 10s SLA plays out over 10 real seconds
const MAX_PAYMENTS = 60;
const STABILITY_GAP_MS = 4000; // no new breach for this long before we'll consider closing
const BACKLOG_SAMPLE_MS = 500; // trend-sample cadence for the Executive/Resilience sparklines

const STATE_LABELS = { HEALTHY: "Healthy", DEGRADING: "Degrading", RECOVERING: "Recovering", STABLE: "Stable" };

const ALERT_META = {
  NONE: { label: "All clear", color: "var(--status-info)", desc: "Service operating within configured SLA." },
  MONITORING: { label: "Monitoring", color: "var(--status-info)", desc: "Latency injected — watching for SLA impact." },
  WARNING: { label: "Warning", color: "var(--status-warning)", desc: "Payments approaching their SLA limit." },
  CRITICAL: { label: "Critical", color: "var(--status-critical)", desc: "Imminent SLA expiry for one or more payments." },
  BREACH: { label: "Breach", color: "var(--status-breach)", desc: "One or more payments have timed out." },
  RECOVERING: { label: "Recovering", color: "var(--status-recovering)", desc: "Degradation has ceased — confirming stability." },
  CLOSED: { label: "Closed", color: "var(--status-healthy)", desc: "Service confirmed stable. Backlog cleared." },
};

const RISK_META = {
  WITHIN_SLA: { label: "Within SLA", color: "var(--status-healthy)" },
  AT_RISK: { label: "At risk", color: "var(--status-warning)" },
  CRITICAL: { label: "Critical", color: "var(--status-critical)" },
};

const TERMINAL_META = {
  TIMED_OUT: { label: "Timed out", color: "var(--status-breach)" },
  COMPLETED: { label: "Completed", color: "var(--status-healthy)" },
};

/* ---------------------------------------------------------------
   Simulation engine
--------------------------------------------------------------- */

function createInitialSim() {
  return {
    simTime: 0,
    payments: [],
    paymentCounter: 0,
    lastSpawnTime: 0,
    nextSpawnGap: 900,
    scenarioState: "HEALTHY",
    injectionStartTime: null,
    recoveryStartTime: null,
    closedTime: null,
    firstWarningTime: null,
    firstBreachTime: null,
    completedSinceRecovery: 0,
    latencyAtRecoveryStart: 820,
    currentFraudLatency: 820,
    alertLevel: "NONE",
    alertLevelSince: 0,
    lastBreachTime: null,
    terminalDurations: [],
    backlogHistory: [],
    lastBacklogSampleTime: 0,
    impactToleranceMs: 60000,
  };
}

function jitter(ms) {
  return ms * (0.85 + Math.random() * 0.3);
}

function fraudLatencyTarget(sim, t) {
  const base = 820;
  if (sim.scenarioState === "DEGRADING" && sim.injectionStartTime != null) {
    const sec = (t - sim.injectionStartTime) / 1000;
    return Math.min(13000, base + sec * 1100);
  }
  if (sim.scenarioState === "RECOVERING" && sim.recoveryStartTime != null) {
    const sec = (t - sim.recoveryStartTime) / 1000;
    const decaySec = 3;
    const frac = Math.max(0, 1 - sec / decaySec);
    const peak = sim.latencyAtRecoveryStart ?? base;
    return base + (peak - base) * frac;
  }
  return base;
}

function spawnPayment(sim, t) {
  sim.paymentCounter += 1;
  const id = `DEMO-PMT-${String(sim.paymentCounter).padStart(5, "0")}`;
  const channel = Math.random() < 0.72 ? "Digital" : "Corporate host-to-host";
  const amount = Math.round(80 + Math.random() * Math.random() * 18000);
  const stage = STAGES[0];
  const dur = jitter(stage.baseMs);
  sim.payments.push({
    id,
    channel,
    amount,
    lane: sim.paymentCounter % 5,
    acceptedAt: t,
    stageIndex: 0,
    events: [{ stage: stage.code, enteredAt: t, endedAt: null, durationMs: null, baseMs: stage.baseMs, plannedMs: dur }],
    stageEndAt: t + dur,
    riskState: "WITHIN_SLA",
    elapsedMs: 0,
    remainingBudgetMs: SLA.breach,
    terminalOutcome: null,
    terminalAt: null,
    terminalStageIndex: null,
  });
}

function computeAlertLevel(sim) {
  if (sim.scenarioState === "HEALTHY") return "NONE";
  if (sim.scenarioState === "STABLE") return "CLOSED";
  if (sim.scenarioState === "RECOVERING") return "RECOVERING";
  const hasBreach = sim.payments.some((p) => p.terminalOutcome === "TIMED_OUT" && p.terminalAt >= sim.injectionStartTime);
  if (hasBreach) return "BREACH";
  const hasCritical = sim.payments.some((p) => !p.terminalOutcome && p.riskState === "CRITICAL");
  if (hasCritical) return "CRITICAL";
  const hasWarning = sim.payments.some((p) => !p.terminalOutcome && p.riskState === "AT_RISK");
  if (hasWarning) return "WARNING";
  return "MONITORING";
}
function updateAlertLevel(sim, t) {
  const level = computeAlertLevel(sim);
  if (level !== sim.alertLevel) sim.alertLevelSince = t;
  sim.alertLevel = level;
}

function stepSimulation(sim, dtMs) {
  sim.simTime += dtMs;
  const t = sim.simTime;

  if (t - sim.lastSpawnTime >= sim.nextSpawnGap) {
    sim.lastSpawnTime = t;
    sim.nextSpawnGap = 900 + Math.random() * 500;
    spawnPayment(sim, t);
  }

  sim.currentFraudLatency = fraudLatencyTarget(sim, t);

  for (const p of sim.payments) {
    if (p.terminalOutcome) continue;

    if (t >= p.stageEndAt) {
      const ev = p.events[p.events.length - 1];
      ev.endedAt = p.stageEndAt;
      ev.durationMs = p.stageEndAt - ev.enteredAt;

      p.stageIndex += 1;
      if (p.stageIndex >= STAGES.length) {
        p.terminalOutcome = "COMPLETED";
        p.terminalAt = t;
        if (sim.scenarioState === "RECOVERING") sim.completedSinceRecovery += 1;
        sim.terminalDurations.push({ duration: t - p.acceptedAt, outcome: "COMPLETED", t });
        if (sim.terminalDurations.length > 200) sim.terminalDurations.shift();
        continue;
      }
      const stage = STAGES[p.stageIndex];
      const target = stage.code === "FRAUD_SANCTIONS" ? sim.currentFraudLatency : stage.baseMs;
      const dur = jitter(target);
      p.stageEndAt = t + dur;
      p.events.push({ stage: stage.code, enteredAt: t, endedAt: null, durationMs: null, baseMs: stage.baseMs, plannedMs: dur });
    }

    const elapsed = t - p.acceptedAt;
    p.elapsedMs = elapsed;
    p.remainingBudgetMs = Math.max(0, SLA.breach - elapsed);

    if (!p.terminalOutcome) {
      if (elapsed >= SLA.breach) {
        p.terminalOutcome = "TIMED_OUT";
        p.terminalAt = t;
        p.terminalStageIndex = p.stageIndex;
        sim.lastBreachTime = t;
        if (sim.firstBreachTime == null) sim.firstBreachTime = t;
        sim.terminalDurations.push({ duration: elapsed, outcome: "TIMED_OUT", t });
        if (sim.terminalDurations.length > 200) sim.terminalDurations.shift();
        const ev = p.events[p.events.length - 1];
        ev.endedAt = t;
        ev.durationMs = t - ev.enteredAt;
        ev.interrupted = true;
      } else if (elapsed >= SLA.critical) {
        p.riskState = "CRITICAL";
      } else if (elapsed >= SLA.warning) {
        p.riskState = "AT_RISK";
        if (sim.firstWarningTime == null && sim.injectionStartTime != null) sim.firstWarningTime = t;
      } else {
        p.riskState = "WITHIN_SLA";
      }
    }
  }

  if (sim.scenarioState === "RECOVERING") {
    const inflightAtRisk = sim.payments.some((p) => !p.terminalOutcome && p.riskState !== "WITHIN_SLA");
    const recentBreach = sim.lastBreachTime != null && t - sim.lastBreachTime < STABILITY_GAP_MS;
    if (!inflightAtRisk && !recentBreach && sim.completedSinceRecovery >= 3) {
      sim.scenarioState = "STABLE";
      sim.closedTime = t;
    }
  }

  if (t - sim.lastBacklogSampleTime >= BACKLOG_SAMPLE_MS) {
    sim.lastBacklogSampleTime = t;
    const backlog = sim.payments.filter((p) => !p.terminalOutcome).length;
    sim.backlogHistory.push({ t, backlog, compliancePct: rollingCompliancePct(sim, 30) });
    if (sim.backlogHistory.length > 60) sim.backlogHistory.shift();
  }

  updateAlertLevel(sim, t);

  if (sim.payments.length > MAX_PAYMENTS) {
    sim.payments.splice(0, sim.payments.length - MAX_PAYMENTS);
  }
}

/* ---------------------------------------------------------------
   Formatting helpers
--------------------------------------------------------------- */

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtMoney(n) {
  return "£" + Math.round(n).toLocaleString("en-GB");
}
function fmtClock(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function getAffected(sim) {
  const rows = sim.payments.filter((p) => p.riskState !== "WITHIN_SLA" || p.terminalOutcome === "TIMED_OUT");
  return { count: rows.length, value: rows.reduce((sum, p) => sum + p.amount, 0) };
}
function rollingCompliancePct(sim, windowSize) {
  const recent = sim.terminalDurations.slice(-windowSize);
  if (recent.length === 0) return null;
  const completed = recent.filter((r) => r.outcome === "COMPLETED").length;
  return (completed / recent.length) * 100;
}
function getPercentiles(durations) {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { p50: pick(0.5), p90: pick(0.9), p95: pick(0.95), p99: pick(0.99) };
}
function getAffectedByChannel(sim) {
  const rows = sim.payments.filter((p) => p.riskState !== "WITHIN_SLA" || p.terminalOutcome === "TIMED_OUT");
  const map = new Map();
  for (const p of rows) {
    const entry = map.get(p.channel) || { channel: p.channel, count: 0, value: 0 };
    entry.count += 1;
    entry.value += p.amount;
    map.set(p.channel, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.value - a.value);
}
function getOldestInflightAge(sim) {
  const inflight = sim.payments.filter((p) => !p.terminalOutcome);
  if (inflight.length === 0) return null;
  return Math.max(...inflight.map((p) => p.elapsedMs));
}

/* ---------------------------------------------------------------
   UI subcomponents
--------------------------------------------------------------- */

function ControlRail({ sim, running, onTogglePlay, onInject, onRecover, onReset }) {
  const canInject = sim.scenarioState === "HEALTHY" || sim.scenarioState === "STABLE";
  const canRecover = sim.scenarioState === "DEGRADING";

  return (
    <aside className="control-rail">
      <div className="control-block">
        <div className="control-title">Scenario control</div>
        <div className="state-row">
          <span className={`state-dot state-dot--${sim.scenarioState.toLowerCase()}`} />
          <span className="state-label">{STATE_LABELS[sim.scenarioState]}</span>
        </div>
      </div>

      <div className="control-block control-buttons">
        <button className="control-btn control-btn--primary" onClick={onTogglePlay}>
          {running ? <Pause size={15} /> : <Play size={15} />}
          {running ? "Pause" : sim.simTime === 0 ? "Start simulation" : "Resume"}
        </button>
        <button className="control-btn control-btn--warn" onClick={onInject} disabled={!canInject}>
          <AlertTriangle size={15} />
          Inject fraud-screening latency
        </button>
        <button className="control-btn control-btn--recover" onClick={onRecover} disabled={!canRecover}>
          <CheckCircle2 size={15} />
          Remove latency &amp; recover
        </button>
        <button className="control-btn control-btn--ghost" onClick={onReset}>
          <RotateCcw size={15} />
          Reset
        </button>
      </div>

      <div className="control-block control-stats">
        <div className="control-stat">
          <span>Time to detect</span>
          <strong>{sim.firstWarningTime != null && sim.injectionStartTime != null ? fmtDuration(sim.firstWarningTime - sim.injectionStartTime) : "—"}</strong>
        </div>
        <div className="control-stat">
          <span>Incident duration</span>
          <strong>{sim.injectionStartTime != null ? fmtDuration((sim.closedTime ?? sim.simTime) - sim.injectionStartTime) : "—"}</strong>
        </div>
        <div className="control-stat">
          <span>Recovery duration</span>
          <strong>{sim.recoveryStartTime != null ? fmtDuration((sim.closedTime ?? sim.simTime) - sim.recoveryStartTime) : "—"}</strong>
        </div>
      </div>

      <p className="control-footnote">
        Synthetic data only. CSM &amp; receiving-bank stages are simulated. SLA defaults (7s / 9s / 10s) are illustrative, pending sign-off.
      </p>
    </aside>
  );
}

function Sparkline({ data, color, height = 34, width = 130 }) {
  if (!data || data.length < 2) {
    return <div className="sparkline-empty">Not enough data yet</div>;
  }
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

function getExecutiveStatus(sim) {
  if (sim.scenarioState === "HEALTHY") return { label: "Healthy", color: "var(--status-healthy)", desc: "All instant payments completing within SLA." };
  if (sim.scenarioState === "RECOVERING") return { label: "Recovering", color: "var(--status-recovering)", desc: "Degradation has ceased — confirming stability before closing." };
  if (sim.scenarioState === "STABLE") return { label: "Stable", color: "var(--status-healthy)", desc: "Service confirmed stable. Backlog cleared." };
  if (sim.alertLevel === "CRITICAL" || sim.alertLevel === "BREACH") {
    return { label: "Impacted", color: "var(--status-breach)", desc: "Customer payments have been timed out or rejected." };
  }
  return { label: "Degrading", color: "var(--status-warning)", desc: "Early signs of latency. No confirmed customer impact yet." };
}

function RecoveryProgress({ sim }) {
  if (sim.scenarioState !== "RECOVERING" && sim.scenarioState !== "STABLE") {
    return <div className="empty-state">No recovery in progress.</div>;
  }
  const completions = Math.min(3, sim.completedSinceRecovery);
  const sinceBreach = sim.lastBreachTime != null ? sim.simTime - sim.lastBreachTime : null;
  return (
    <div className="recovery-progress">
      <div className="recovery-progress-row">
        <span>Clean completions since recovery</span>
        <strong>{completions} / 3</strong>
      </div>
      <div className="recovery-progress-row">
        <span>Time clear of new breaches</span>
        <strong>{sinceBreach != null ? `${fmtDuration(Math.min(sinceBreach, STABILITY_GAP_MS))} / ${fmtDuration(STABILITY_GAP_MS)}` : "n/a"}</strong>
      </div>
      {sim.scenarioState === "STABLE" && <div className="recovery-progress-done">Confirmed stable.</div>}
    </div>
  );
}

function ExecutiveOverview({ sim }) {
  const status = getExecutiveStatus(sim);
  const affected = getAffected(sim);
  const oldest = getOldestInflightAge(sim);
  const backlogNow = sim.payments.filter((p) => !p.terminalOutcome).length;
  const complianceNow = rollingCompliancePct(sim, 30);
  const complianceSeries = sim.backlogHistory.map((h) => ({ value: h.compliancePct == null ? 100 : h.compliancePct }));
  const backlogSeries = sim.backlogHistory.map((h) => ({ value: h.backlog }));

  return (
    <div className="exec-view">
      <div className="exec-hero" style={{ "--accent": status.color }}>
        <span className="exec-hero-dot" />
        <div>
          <div className="exec-hero-label">{status.label}</div>
          <div className="exec-hero-desc">{status.desc}</div>
        </div>
      </div>

      <div className="exec-grid">
        <section className="panel">
          <div className="panel-title">Business impact</div>
          <div className="exec-impact-row">
            <div className="exec-stat"><strong>{affected.count}</strong><span>payments affected</span></div>
            <div className="exec-stat"><strong>{fmtMoney(affected.value)}</strong><span>value exposed</span></div>
            <div className="exec-stat"><strong>{oldest != null ? fmtDuration(oldest) : "—"}</strong><span>oldest in-flight</span></div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">Recovery &amp; stability</div>
          <RecoveryProgress sim={sim} />
        </section>

        <section className="panel">
          <div className="panel-title">SLA compliance — recent 30 payments</div>
          <div className="exec-trend-row">
            <div className="exec-trend-value">{complianceNow != null ? `${complianceNow.toFixed(0)}%` : "—"}</div>
            <Sparkline data={complianceSeries} color="var(--status-healthy)" />
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">Backlog trend</div>
          <div className="exec-trend-row">
            <div className="exec-trend-value">{backlogNow}</div>
            <Sparkline data={backlogSeries} color="var(--gold-300)" />
          </div>
        </section>
      </div>
    </div>
  );
}

function IncidentRecord({ sim }) {
  const checkpoints = [
    { label: "First degradation", time: sim.injectionStartTime },
    { label: "First warning", time: sim.firstWarningTime },
    { label: "First timeout / rejection", time: sim.firstBreachTime },
    { label: "Recovery start", time: sim.recoveryStartTime },
    { label: "Confirmed stable", time: sim.closedTime },
  ];
  if (sim.injectionStartTime == null) {
    return <div className="empty-state">No incident has been raised yet.</div>;
  }
  let prevTime = null;
  return (
    <table className="data-table">
      <thead>
        <tr><th>Checkpoint</th><th>Time</th><th>Since previous</th></tr>
      </thead>
      <tbody>
        {checkpoints.map((c) => {
          const delta = c.time != null && prevTime != null ? c.time - prevTime : null;
          if (c.time != null) prevTime = c.time;
          return (
            <tr key={c.label}>
              <td>{c.label}</td>
              <td className="mono">{c.time != null ? fmtClock(c.time) : "Pending"}</td>
              <td className="mono">{delta != null ? fmtDuration(delta) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PercentileTable({ durations }) {
  const p = getPercentiles(durations);
  if (!p) return <div className="empty-state">No completed or timed-out payments yet.</div>;
  return (
    <div className="percentile-row">
      <div className="percentile-stat"><span>P50</span><strong>{fmtDuration(p.p50)}</strong></div>
      <div className="percentile-stat"><span>P90</span><strong>{fmtDuration(p.p90)}</strong></div>
      <div className="percentile-stat"><span>P95</span><strong>{fmtDuration(p.p95)}</strong></div>
      <div className="percentile-stat"><span>P99</span><strong>{fmtDuration(p.p99)}</strong></div>
    </div>
  );
}

function BreachStats({ sim }) {
  const total = sim.terminalDurations.length;
  const timedOut = sim.terminalDurations.filter((d) => d.outcome === "TIMED_OUT").length;
  const rate = total > 0 ? (timedOut / total) * 100 : null;
  const timeInBreach = sim.firstBreachTime != null ? (sim.recoveryStartTime ?? sim.simTime) - sim.firstBreachTime : null;
  return (
    <div className="exec-impact-row">
      <div className="exec-stat"><strong>{timedOut}</strong><span>breach count</span></div>
      <div className="exec-stat"><strong>{rate != null ? `${rate.toFixed(1)}%` : "—"}</strong><span>breach rate</span></div>
      <div className="exec-stat"><strong>{fmtDuration(timeInBreach)}</strong><span>time in breach</span></div>
    </div>
  );
}

function ToleranceGauge({ sim }) {
  if (sim.injectionStartTime == null) {
    return <div className="empty-state">No incident to measure against tolerance yet.</div>;
  }
  const incidentMs = (sim.closedTime ?? sim.simTime) - sim.injectionStartTime;
  const rawPct = (incidentMs / sim.impactToleranceMs) * 100;
  const displayPct = Math.min(100, rawPct);
  const color = rawPct >= 100 ? "var(--status-breach)" : rawPct >= 70 ? "var(--status-warning)" : "var(--status-healthy)";
  return (
    <>
      <div className="tolerance-bar-track">
        <div className="tolerance-bar-fill" style={{ width: `${displayPct}%`, background: color }} />
      </div>
      <div className="tolerance-bar-value mono">
        {rawPct.toFixed(0)}% of tolerance consumed ({fmtDuration(incidentMs)} / {fmtDuration(sim.impactToleranceMs)})
      </div>
    </>
  );
}

function ResilienceView({ sim, onSetImpactTolerance }) {
  const allDurations = sim.terminalDurations.map((d) => d.duration);
  const complianceOverall = rollingCompliancePct(sim, 200);
  const backlogSeries = sim.backlogHistory.map((h) => ({ value: h.backlog }));

  return (
    <div className="resilience-view">
      <div className="resilience-section-label">Service measures</div>
      <div className="exec-grid">
        <section className="panel">
          <div className="panel-title">Incident record</div>
          <IncidentRecord sim={sim} />
        </section>
        <section className="panel">
          <div className="panel-title">Recovery evidence</div>
          <RecoveryProgress sim={sim} />
          <div className="resilience-subrow">
            <span>Fraud-stage latency vs baseline</span>
            <strong className="mono">{fmtDuration(sim.currentFraudLatency)} / {fmtDuration(820)}</strong>
          </div>
          <div className="resilience-subrow"><span>Backlog trend</span></div>
          <Sparkline data={backlogSeries} color="var(--gold-300)" />
        </section>
      </div>

      <div className="resilience-section-label">Transaction measures</div>
      <div className="exec-grid">
        <section className="panel">
          <div className="panel-title">Latency percentiles — all terminal payments</div>
          <PercentileTable durations={allDurations} />
        </section>
        <section className="panel">
          <div className="panel-title">SLA compliance &amp; breach rate</div>
          <div className="exec-trend-row" style={{ marginBottom: "12px" }}>
            <div className="exec-trend-value">{complianceOverall != null ? `${complianceOverall.toFixed(0)}%` : "—"}</div>
            <span className="resilience-caption">overall compliance ({sim.terminalDurations.length} terminal payments)</span>
          </div>
          <BreachStats sim={sim} />
        </section>
        <section className="panel" style={{ gridColumn: "1 / -1" }}>
          <div className="panel-title">Impact-tolerance consumption</div>
          <label className="tolerance-input-row">
            <span>Impact tolerance (illustrative — pending D-04 sign-off)</span>
            <span className="tolerance-input-wrap">
              <input
                type="number"
                min="5"
                step="5"
                className="tolerance-input"
                value={Math.round(sim.impactToleranceMs / 1000)}
                onChange={(e) => onSetImpactTolerance(Math.max(5, Number(e.target.value) || 5) * 1000)}
              />
              <span>s</span>
            </span>
          </label>
          <ToleranceGauge sim={sim} />
        </section>
      </div>
    </div>
  );
}

function AlertBanner({ sim }) {
  const meta = ALERT_META[sim.alertLevel] || ALERT_META.NONE;
  const affected = getAffected(sim);
  const oldest = getOldestInflightAge(sim);
  return (
    <div className={`alert-banner alert-banner--${sim.alertLevel.toLowerCase()}`} style={{ "--accent": meta.color }}>
      <span className="alert-dot" />
      <div className="alert-copy">
        <div className="alert-level">
          {meta.label}
          <span className="alert-since">for {fmtDuration(sim.simTime - sim.alertLevelSince)}</span>
        </div>
        <div className="alert-desc">{meta.desc}</div>
      </div>
      <div className="alert-metrics">
        <div className="alert-metric"><strong>{affected.count}</strong><span>at-risk payments</span></div>
        <div className="alert-metric"><strong>{fmtMoney(affected.value)}</strong><span>value exposed</span></div>
        <div className="alert-metric"><strong>{oldest != null ? fmtDuration(oldest) : "—"}</strong><span>oldest in-flight</span></div>
      </div>
    </div>
  );
}

function PipelineFlow({ sim, onSelect, selectedId }) {
  const total = STAGES.reduce((s, st) => s + st.baseMs, 0);
  const MIN_PCT = 0.065; // floor so short stages (e.g. Channel entry) still fit a label
  const remainingPct = 1 - MIN_PCT * STAGES.length;
  let acc = 0;
  const segments = STAGES.map((s) => {
    const widthPct = MIN_PCT + remainingPct * (s.baseMs / total);
    const start = acc;
    acc += widthPct;
    return { ...s, start, end: acc };
  });

  const now = sim.simTime;
  const visible = sim.payments.filter((p) => !p.terminalOutcome || now - p.terminalAt < 1600);

  return (
    <div className="pipeline">
      <div className="pipeline-track">
        {segments.map((seg) => (
          <div
            key={seg.code}
            className={`pipeline-segment pipeline-segment--${seg.owner}${seg.code === "FRAUD_SANCTIONS" && sim.scenarioState !== "HEALTHY" ? " pipeline-segment--watched" : ""}`}
            style={{ left: `${seg.start * 100}%`, width: `${(seg.end - seg.start) * 100}%` }}
          >
            <span className="pipeline-segment-label">{seg.label}</span>
            {seg.simulated && <span className="pipeline-segment-tag">Simulated</span>}
            {seg.code === "FRAUD_SANCTIONS" && sim.scenarioState !== "HEALTHY" && (
              <span className="pipeline-live-metric">{fmtDuration(sim.currentFraudLatency)} now</span>
            )}
          </div>
        ))}

        {visible.map((p) => {
          const idx = p.terminalOutcome === "TIMED_OUT" ? p.terminalStageIndex : p.stageIndex;
          const seg = segments[Math.min(idx, segments.length - 1)];
          const ev = p.events[idx];
          let frac;
          if (p.terminalOutcome === "COMPLETED") {
            frac = 1;
          } else if (p.terminalOutcome === "TIMED_OUT") {
            frac = ev ? Math.min(1, (p.terminalAt - ev.enteredAt) / (ev.plannedMs || seg.baseMs)) : 0;
          } else {
            frac = ev ? Math.min(1, (now - ev.enteredAt) / (ev.plannedMs || seg.baseMs)) : 0;
          }
          const xPct = p.terminalOutcome === "COMPLETED" ? 100.5 : (seg.start + frac * (seg.end - seg.start)) * 100;
          const age = p.terminalAt != null ? now - p.terminalAt : 0;
          const fadeOpacity = p.terminalOutcome && age > 700 ? Math.max(0, 1 - (age - 700) / 700) : 1;
          const color =
            p.terminalOutcome === "TIMED_OUT" ? "var(--status-breach)"
            : p.terminalOutcome === "COMPLETED" ? "var(--status-healthy)"
            : RISK_META[p.riskState]?.color || "var(--status-healthy)";
          return (
            <div
              key={p.id}
              className={`pipeline-dot${selectedId === p.id ? " pipeline-dot--selected" : ""}${p.terminalOutcome === "TIMED_OUT" ? " pipeline-dot--breach" : ""}`}
              style={{ left: `${xPct}%`, top: `${47 + p.lane * 9}px`, background: color, opacity: fadeOpacity }}
              onClick={() => onSelect(p.id)}
              title={`${p.id} — ${p.terminalOutcome || RISK_META[p.riskState]?.label}`}
            />
          );
        })}
      </div>
      <div className="pipeline-legend">
        <span><i style={{ background: "var(--status-healthy)" }} />Within SLA</span>
        <span><i style={{ background: "var(--status-warning)" }} />At risk</span>
        <span><i style={{ background: "var(--status-critical)" }} />Critical</span>
        <span><i style={{ background: "var(--status-breach)" }} />Timed out</span>
      </div>
    </div>
  );
}

function IncidentChronology({ sim }) {
  const checkpoints = [
    { label: "First degradation", time: sim.injectionStartTime },
    { label: "First warning", time: sim.firstWarningTime },
    { label: "First timeout / rejection", time: sim.firstBreachTime },
    { label: "Recovery start", time: sim.recoveryStartTime },
    { label: "Confirmed stable", time: sim.closedTime },
  ];
  if (sim.injectionStartTime == null) {
    return <div className="empty-state">No incident has been raised yet.</div>;
  }
  return (
    <ol className="chrono-list">
      {checkpoints.map((c) => (
        <li key={c.label} className={`chrono-item${c.time != null ? " chrono-item--reached" : ""}`}>
          <span className="chrono-marker" />
          <span className="chrono-label">{c.label}</span>
          <span className="chrono-time mono">{c.time != null ? fmtClock(c.time) : "Pending"}</span>
        </li>
      ))}
    </ol>
  );
}

function ChannelBreakdown({ sim }) {
  const rows = getAffectedByChannel(sim);
  if (rows.length === 0) return null;
  return (
    <div className="channel-breakdown">
      {rows.map((r) => (
        <div key={r.channel} className="channel-chip">
          <span className="channel-chip-name">{r.channel}</span>
          <span className="channel-chip-stats mono">{r.count} affected · {fmtMoney(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function CohortTable({ sim, onSelect }) {
  const rows = sim.payments
    .filter((p) => p.riskState !== "WITHIN_SLA" || p.terminalOutcome === "TIMED_OUT")
    .sort((a, b) => {
      if (a.terminalOutcome && !b.terminalOutcome) return -1;
      if (!a.terminalOutcome && b.terminalOutcome) return 1;
      if (a.terminalOutcome && b.terminalOutcome) return b.terminalAt - a.terminalAt;
      return a.remainingBudgetMs - b.remainingBudgetMs;
    })
    .slice(0, 10);

  if (rows.length === 0) {
    return <div className="empty-state">No at-risk payments. Service is operating within the configured SLA.</div>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Payment</th>
          <th>Channel</th>
          <th>Stage</th>
          <th>Elapsed</th>
          <th>Budget / outcome</th>
          <th>Value</th>
          <th>Risk</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const stage = STAGES[p.terminalOutcome ? p.terminalStageIndex ?? p.stageIndex : p.stageIndex];
          const risk = p.terminalOutcome ? TERMINAL_META[p.terminalOutcome] : RISK_META[p.riskState];
          return (
            <tr key={p.id} onClick={() => onSelect(p.id)} className="data-row">
              <td className="mono">{p.id}</td>
              <td>{p.channel}</td>
              <td>{stage?.label}</td>
              <td className="mono">{fmtDuration(p.elapsedMs)}</td>
              <td className="mono">{p.terminalOutcome ? risk.label : fmtDuration(p.remainingBudgetMs) + " left"}</td>
              <td className="mono">{fmtMoney(p.amount)}</td>
              <td><span className="risk-chip" style={{ "--chip-color": risk.color }}>{risk.label}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SlaBar({ payment }) {
  const elapsed = payment.terminalOutcome ? payment.terminalAt - payment.acceptedAt : payment.elapsedMs;
  const pct = Math.min(100, (elapsed / SLA.breach) * 100);
  const color = payment.terminalOutcome === "TIMED_OUT" ? "var(--status-breach)" : RISK_META[payment.riskState]?.color || "var(--status-healthy)";
  return (
    <div className="sla-bar">
      <div className="sla-bar-track">
        <div className="sla-bar-fill" style={{ width: `${pct}%`, background: color }} />
        <div className="sla-marker" style={{ left: "70%" }}><span>7s warn</span></div>
        <div className="sla-marker" style={{ left: "90%" }}><span>9s critical</span></div>
        <div className="sla-marker sla-marker--end" style={{ left: "100%" }}><span>10s SLA</span></div>
      </div>
      <div className="sla-bar-value mono">{fmtDuration(elapsed)} elapsed</div>
    </div>
  );
}

function StageTimeline({ payment, simTime }) {
  return (
    <ol className="stage-timeline">
      {STAGES.map((s, i) => {
        let status = "pending";
        if (payment.terminalOutcome === "COMPLETED") status = "done";
        else if (payment.terminalOutcome === "TIMED_OUT") {
          if (i < payment.terminalStageIndex) status = "done";
          else if (i === payment.terminalStageIndex) status = "interrupted";
          else status = "skipped";
        } else {
          if (i < payment.stageIndex) status = "done";
          else if (i === payment.stageIndex) status = "current";
        }
        const ev = payment.events[i];
        const duration = ev ? (ev.durationMs != null ? ev.durationMs : simTime - ev.enteredAt) : null;

        return (
          <li key={s.code} className={`timeline-item timeline-item--${status}`}>
            <span className="timeline-marker" />
            <div className="timeline-body">
              <div className="timeline-head">
                <span className="timeline-label">{s.label}</span>
                {s.simulated && <span className="timeline-tag">Simulated</span>}
                <span className="timeline-dir">{s.direction === "in" ? "inbound" : s.direction === "out" ? "outbound" : "internal"}</span>
              </div>
              <div className="timeline-meta mono">
                {status === "pending" && "Not yet reached"}
                {status === "skipped" && "Not reached — payment did not proceed"}
                {(status === "done" || status === "current" || status === "interrupted") && duration != null && (
                  <>
                    {fmtDuration(duration)}
                    {status === "interrupted" && " — stopped before completion"}
                    {status === "current" && " — in progress"}
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TraceView({ sim, selectedId, onSelect, onBack }) {
  const recent = [...sim.payments].reverse().slice(0, 15);
  const payment = sim.payments.find((p) => p.id === selectedId) || recent[0] || null;

  return (
    <div className="trace-panel">
      <div className="trace-topbar">
        <button className="back-link" onClick={onBack}>
          <ArrowLeft size={14} />
          Back to Command Centre
        </button>
      </div>
      <div className="trace-layout">
      <div className="trace-list">
        {recent.length === 0 && <div className="empty-state">Start the simulation to generate payment traffic.</div>}
        {recent.map((p) => {
          const risk = p.terminalOutcome ? TERMINAL_META[p.terminalOutcome] : RISK_META[p.riskState];
          return (
            <button
              key={p.id}
              className={`trace-list-item${payment && payment.id === p.id ? " trace-list-item--active" : ""}`}
              onClick={() => onSelect(p.id)}
            >
              <span className="mono">{p.id}</span>
              <span className="risk-chip" style={{ "--chip-color": risk.color }}>{risk.label}</span>
            </button>
          );
        })}
      </div>

      <div className="trace-detail">
        {!payment && <div className="empty-state">Select a payment to inspect its journey.</div>}
        {payment && (
          <>
            <div className="trace-header">
              <div>
                <div className="trace-id mono">{payment.id}</div>
                <div className="trace-sub">{payment.channel} · {fmtMoney(payment.amount)} · Instant Pay Rail A</div>
              </div>
              {payment.terminalOutcome === "TIMED_OUT" && (
                <div className="terminal-banner">
                  Timed out at {STAGES[payment.terminalStageIndex]?.label} — did not proceed to the scheme adapter or clearing path.
                </div>
              )}
              {payment.terminalOutcome === "COMPLETED" && (
                <div className="terminal-banner terminal-banner--ok">Completed within SLA.</div>
              )}
            </div>
            <SlaBar payment={payment} />
            <StageTimeline payment={payment} simTime={sim.simTime} />
          </>
        )}
      </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Root component
--------------------------------------------------------------- */

export default function PaymentsObservabilityPrototype() {
  const simRef = useRef(createInitialSim());
  const [, bump] = useState(0);
  const [running, setRunning] = useState(false);
  const [activeTab, setActiveTab] = useState("exec");
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      stepSimulation(simRef.current, TICK_SIM_MS);
      bump((n) => n + 1);
    }, TICK_REAL_MS);
    return () => clearInterval(id);
  }, [running]);

  const sim = simRef.current;

  function onTogglePlay() {
    setRunning((r) => !r);
  }
  function onInject() {
    const s = simRef.current;
    s.scenarioState = "DEGRADING";
    s.injectionStartTime = s.simTime;
    s.firstWarningTime = null;
    s.firstBreachTime = null;
    s.closedTime = null;
    s.completedSinceRecovery = 0;
    setRunning(true);
    bump((n) => n + 1);
  }
  function onRecover() {
    const s = simRef.current;
    s.latencyAtRecoveryStart = fraudLatencyTarget(s, s.simTime);
    s.scenarioState = "RECOVERING";
    s.recoveryStartTime = s.simTime;
    s.completedSinceRecovery = 0;
    bump((n) => n + 1);
  }
  function onReset() {
    simRef.current = createInitialSim();
    setRunning(false);
    setSelectedId(null);
    setActiveTab("ops");
    bump((n) => n + 1);
  }
  function selectPayment(id) {
    setSelectedId(id);
    setActiveTab("trace");
  }
  function onSetImpactTolerance(ms) {
    simRef.current.impactToleranceMs = ms;
    bump((n) => n + 1);
  }

  return (
    <div className="poc-root">
      <style>{CSS}</style>

      <header className="poc-header">
        <div>
          <div className="poc-title">Real-Time Payment SLA &amp; Journey Observability</div>
          <div className="poc-subtitle">Scenario: Instant-payment fraud &amp; sanctions screening latency degradation</div>
        </div>
        <div className="poc-clock mono">
          <span>Scenario clock</span>
          <strong>{fmtClock(sim.simTime)}</strong>
        </div>
      </header>

      <div className="poc-body">
        <ControlRail sim={sim} running={running} onTogglePlay={onTogglePlay} onInject={onInject} onRecover={onRecover} onReset={onReset} />

        <main className="poc-main">
          <nav className="poc-tabs">
            <button className={`poc-tab${activeTab === "exec" ? " poc-tab--active" : ""}`} onClick={() => setActiveTab("exec")}>
              Executive Payment Health Overview
            </button>
            <button className={`poc-tab${activeTab === "ops" ? " poc-tab--active" : ""}`} onClick={() => setActiveTab("ops")}>
              Payments Operations Command Centre
            </button>
            <button className={`poc-tab${activeTab === "trace" ? " poc-tab--active" : ""}`} onClick={() => setActiveTab("trace")}>
              Transaction Journey Trace
            </button>
            <button className={`poc-tab${activeTab === "resilience" ? " poc-tab--active" : ""}`} onClick={() => setActiveTab("resilience")}>
              SLA &amp; Operational Resilience
            </button>
          </nav>

          {activeTab === "exec" && <ExecutiveOverview sim={sim} />}

          {activeTab === "ops" && (
            <div className="ops-view">
              <AlertBanner sim={sim} />
              <section className="panel">
                <div className="panel-title">Live payment flow</div>
                <PipelineFlow sim={sim} onSelect={selectPayment} selectedId={selectedId} />
              </section>
              <section className="panel">
                <div className="panel-title">Incident chronology</div>
                <IncidentChronology sim={sim} />
              </section>
              <section className="panel">
                <div className="panel-title">At-risk &amp; breached cohort</div>
                <ChannelBreakdown sim={sim} />
                <CohortTable sim={sim} onSelect={selectPayment} />
              </section>
            </div>
          )}

          {activeTab === "trace" && (
            <section className="panel panel--flush">
              <TraceView sim={sim} selectedId={selectedId} onSelect={setSelectedId} onBack={() => setActiveTab("ops")} />
            </section>
          )}

          {activeTab === "resilience" && <ResilienceView sim={sim} onSetImpactTolerance={onSetImpactTolerance} />}
        </main>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Styles
--------------------------------------------------------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.poc-root {
  --navy-950: #0A1220;
  --navy-900: #101A2C;
  --navy-800: #17243B;
  --navy-700: #24345A;
  --navy-600: #3A4E7A;
  --gold-500: #B8923F;
  --gold-300: #D9BB74;
  --ink-50: #F3F5F8;
  --ink-300: #A9B4C6;
  --ink-500: #6B7890;
  --status-healthy: #3FB27F;
  --status-warning: #E8A93B;
  --status-critical: #E8763B;
  --status-breach: #E4514B;
  --status-recovering: #4FA3D1;
  --status-info: #6B7890;

  font-family: 'IBM Plex Sans', sans-serif;
  background: var(--navy-950);
  color: var(--ink-50);
  border-radius: 12px;
  overflow: hidden;
  min-height: 720px;
}
.poc-root .mono { font-family: 'IBM Plex Mono', monospace; }

.poc-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  padding: 20px 24px 16px; border-bottom: 1px solid var(--navy-700);
}
.poc-title { font-family: 'Fraunces', serif; font-size: 21px; font-weight: 600; letter-spacing: 0.2px; }
.poc-subtitle { color: var(--ink-300); font-size: 13px; margin-top: 4px; }
.poc-clock { text-align: right; color: var(--ink-300); font-size: 11px; display: flex; flex-direction: column; gap: 2px; }
.poc-clock strong { color: var(--gold-300); font-size: 16px; }

.poc-body { display: grid; grid-template-columns: 260px 1fr; min-height: 640px; }
@media (max-width: 860px) { .poc-body { grid-template-columns: 1fr; } }

.control-rail { border-right: 1px solid var(--navy-700); padding: 18px; display: flex; flex-direction: column; gap: 18px; background: var(--navy-900); }
.control-block { display: flex; flex-direction: column; gap: 8px; }
.control-title { font-size: 12px; color: var(--ink-300); font-weight: 600; }
.state-row { display: flex; align-items: center; gap: 8px; }
.state-label { font-size: 15px; font-weight: 600; }
.state-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.state-dot--healthy { background: var(--status-healthy); }
.state-dot--degrading { background: var(--status-critical); }
.state-dot--recovering { background: var(--status-recovering); }
.state-dot--stable { background: var(--status-healthy); }

.control-buttons { gap: 8px; }
.control-btn {
  display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 7px;
  font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid var(--navy-600);
  background: var(--navy-800); color: var(--ink-50); transition: border-color 0.15s ease;
}
.control-btn:hover:not(:disabled) { border-color: var(--gold-500); }
.control-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.control-btn--primary { background: var(--gold-500); color: var(--navy-950); border-color: var(--gold-500); font-weight: 600; }
.control-btn--primary:hover:not(:disabled) { background: var(--gold-300); border-color: var(--gold-300); }
.control-btn--warn { color: var(--status-warning); }
.control-btn--recover { color: var(--status-recovering); }
.control-btn--ghost { color: var(--ink-300); }

.control-stats { border-top: 1px solid var(--navy-700); padding-top: 14px; gap: 10px; }
.control-stat { display: flex; justify-content: space-between; font-size: 12px; color: var(--ink-300); }
.control-stat strong { color: var(--ink-50); font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
.control-footnote { font-size: 11px; color: var(--ink-500); line-height: 1.5; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--navy-700); }

.poc-main { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
.poc-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--navy-700); }
.poc-tab { padding: 10px 6px; margin-right: 18px; background: none; border: none; color: var(--ink-300); font-size: 13px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; }
.poc-tab--active { color: var(--gold-300); border-bottom-color: var(--gold-500); }

.panel { background: var(--navy-900); border: 1px solid var(--navy-700); border-radius: 10px; padding: 16px; }
.panel--flush { padding: 0; overflow: hidden; }
.panel-title { font-size: 12px; color: var(--ink-300); font-weight: 600; margin-bottom: 12px; }

.chrono-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.chrono-item { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-left: 2px solid var(--navy-700); margin-left: 5px; padding-left: 16px; position: relative; }
.chrono-marker { position: absolute; left: -6px; width: 10px; height: 10px; border-radius: 50%; background: var(--navy-700); }
.chrono-item--reached .chrono-marker { background: var(--gold-500); }
.chrono-label { font-size: 12.5px; flex: 1; color: var(--ink-50); }
.chrono-item:not(.chrono-item--reached) .chrono-label { color: var(--ink-500); }
.chrono-time { font-size: 11.5px; color: var(--ink-300); }
.chrono-item:not(.chrono-item--reached) .chrono-time { color: var(--ink-500); }

.channel-breakdown { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.channel-chip { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--navy-700); border-radius: 7px; padding: 6px 10px; background: var(--navy-800); }
.channel-chip-name { font-size: 11px; color: var(--ink-300); }
.channel-chip-stats { font-size: 12.5px; color: var(--ink-50); }

.exec-view { display: flex; flex-direction: column; gap: 16px; }
.exec-hero { display: flex; align-items: center; gap: 14px; padding: 20px; border-radius: 10px; border: 1px solid var(--accent); background: var(--navy-900); }
.exec-hero-dot { width: 14px; height: 14px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.exec-hero-label { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 600; color: var(--accent); }
.exec-hero-desc { font-size: 13px; color: var(--ink-300); margin-top: 4px; }
.exec-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 760px) { .exec-grid { grid-template-columns: 1fr; } }
.exec-impact-row { display: flex; gap: 26px; }
.exec-stat { display: flex; flex-direction: column; gap: 2px; }
.exec-stat strong { font-family: 'IBM Plex Mono', monospace; font-size: 18px; }
.exec-stat span { font-size: 10.5px; color: var(--ink-500); }
.exec-trend-row { display: flex; align-items: center; gap: 16px; }
.exec-trend-value { font-family: 'IBM Plex Mono', monospace; font-size: 24px; min-width: 62px; }
.sparkline { flex: 1; height: 36px; }
.sparkline-empty { font-size: 11px; color: var(--ink-500); }
.recovery-progress { display: flex; flex-direction: column; gap: 9px; }
.recovery-progress-row { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--ink-300); }
.recovery-progress-row strong { color: var(--ink-50); font-family: 'IBM Plex Mono', monospace; }
.recovery-progress-done { font-size: 12px; color: var(--status-healthy); margin-top: 2px; }

.resilience-view { display: flex; flex-direction: column; gap: 10px; }
.resilience-section-label { font-size: 11.5px; color: var(--gold-300); font-weight: 600; margin-top: 6px; }
.resilience-subrow { display: flex; justify-content: space-between; font-size: 12px; color: var(--ink-300); margin: 10px 0 6px; }
.resilience-subrow strong { color: var(--ink-50); }
.resilience-caption { font-size: 11px; color: var(--ink-500); }
.percentile-row { display: flex; gap: 22px; }
.percentile-stat { display: flex; flex-direction: column; gap: 3px; }
.percentile-stat span { font-size: 10.5px; color: var(--ink-500); }
.percentile-stat strong { font-family: 'IBM Plex Mono', monospace; font-size: 16px; }
.tolerance-input-row { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: var(--ink-300); margin-bottom: 12px; gap: 12px; }
.tolerance-input-wrap { display: flex; align-items: center; gap: 5px; color: var(--ink-50); flex-shrink: 0; }
.tolerance-input { width: 64px; background: var(--navy-800); border: 1px solid var(--navy-600); color: var(--ink-50); border-radius: 6px; padding: 4px 6px; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; }
.tolerance-input:focus { outline: none; border-color: var(--gold-500); }
.tolerance-bar-track { position: relative; height: 8px; background: var(--navy-800); border-radius: 4px; margin-bottom: 8px; overflow: hidden; }
.tolerance-bar-fill { position: absolute; top: 0; left: 0; height: 100%; border-radius: 4px; transition: width 0.2s ease; }
.tolerance-bar-value { font-size: 11.5px; color: var(--ink-300); }

.alert-banner { display: flex; align-items: center; gap: 16px; padding: 16px 18px; border-radius: 10px; border: 1px solid var(--accent); background: var(--navy-900); }
.alert-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.alert-banner--critical .alert-dot, .alert-banner--breach .alert-dot { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 var(--accent); } 50% { box-shadow: 0 0 0 6px transparent; } }
.alert-copy { flex: 1; }
.alert-level { font-family: 'Fraunces', serif; font-size: 22px; font-weight: 600; color: var(--accent); display: flex; align-items: baseline; gap: 10px; }
.alert-since { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 400; color: var(--ink-500); }
.alert-desc { font-size: 12.5px; color: var(--ink-300); margin-top: 2px; }
.alert-metrics { display: flex; gap: 22px; }
.alert-metric { text-align: right; }
.alert-metric strong { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 16px; }
.alert-metric span { font-size: 10.5px; color: var(--ink-500); }

.pipeline-track { position: relative; height: 92px; background: var(--navy-800); border-radius: 8px; border: 1px solid var(--navy-700); overflow: hidden; margin-bottom: 10px; }
.pipeline-segment { position: absolute; top: 0; bottom: 0; border-right: 1px solid var(--navy-700); padding: 6px 7px; box-sizing: border-box; overflow: hidden; }
.pipeline-segment--csm, .pipeline-segment--receiving { background: repeating-linear-gradient(135deg, rgba(255,255,255,0.025) 0 8px, transparent 8px 16px); }
.pipeline-segment--watched { background: rgba(232,118,59,0.10); }
.pipeline-segment-label { display: block; font-size: 9.5px; line-height: 1.25; color: var(--ink-300); }
.pipeline-segment-tag { display: inline-block; margin-top: 3px; font-size: 8.5px; color: var(--gold-300); border: 1px solid var(--gold-500); border-radius: 8px; padding: 0 5px; white-space: nowrap; }
.pipeline-live-metric { position: absolute; top: 6px; right: 7px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: var(--status-critical); white-space: nowrap; }
.pipeline-dot { position: absolute; width: 8px; height: 8px; border-radius: 50%; transform: translate(-50%, -50%); transition: left 0.12s linear, opacity 0.3s ease; cursor: pointer; box-shadow: 0 0 0 2px var(--navy-800); }
.pipeline-dot--breach { animation: pulse 0.8s ease-in-out 2; }
.pipeline-dot--selected { box-shadow: 0 0 0 2px var(--gold-300); }
.pipeline-legend { display: flex; gap: 16px; font-size: 10.5px; color: var(--ink-500); }
.pipeline-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }

.data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.data-table th { text-align: left; color: var(--ink-500); font-weight: 500; font-size: 11px; padding: 6px 10px; border-bottom: 1px solid var(--navy-700); }
.data-table td { padding: 9px 10px; border-bottom: 1px solid var(--navy-800); }
.data-row { cursor: pointer; }
.data-row:hover { background: var(--navy-800); }
.risk-chip { border: 1px solid var(--chip-color); color: var(--chip-color); border-radius: 20px; padding: 2px 9px; font-size: 11px; }
.empty-state { color: var(--ink-500); font-size: 13px; padding: 24px 8px; text-align: center; }

.trace-topbar { padding: 10px 14px; border-bottom: 1px solid var(--navy-700); }
.back-link { display: flex; align-items: center; gap: 6px; background: none; border: none; color: var(--ink-300); font-size: 12.5px; font-weight: 500; cursor: pointer; padding: 2px 0; }
.back-link:hover { color: var(--gold-300); }
.trace-layout { display: grid; grid-template-columns: 220px 1fr; min-height: 480px; }
.trace-list { border-right: 1px solid var(--navy-700); padding: 10px; display: flex; flex-direction: column; gap: 4px; max-height: 560px; overflow-y: auto; }
.trace-list-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; background: none; border: 1px solid transparent; border-radius: 7px; padding: 8px 10px; color: var(--ink-300); font-size: 12px; cursor: pointer; text-align: left; }
.trace-list-item:hover { background: var(--navy-800); }
.trace-list-item--active { background: var(--navy-800); border-color: var(--gold-500); color: var(--ink-50); }
.trace-detail { padding: 18px; }
.trace-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.trace-id { font-size: 15px; font-weight: 600; }
.trace-sub { font-size: 12px; color: var(--ink-300); margin-top: 2px; }
.terminal-banner { border: 1px solid var(--status-breach); color: var(--status-breach); border-radius: 7px; padding: 8px 12px; font-size: 12px; max-width: 320px; }
.terminal-banner--ok { border-color: var(--status-healthy); color: var(--status-healthy); }

.sla-bar { margin-bottom: 22px; }
.sla-bar-track { position: relative; height: 8px; background: var(--navy-800); border-radius: 4px; margin: 20px 0 10px; }
.sla-bar-fill { position: absolute; top: 0; left: 0; height: 100%; border-radius: 4px; transition: width 0.15s linear; }
.sla-marker { position: absolute; top: -14px; transform: translateX(-50%); font-size: 9.5px; color: var(--ink-500); border-left: 1px solid var(--navy-600); padding-left: 4px; height: 22px; display: flex; align-items: flex-end; }
.sla-marker span { white-space: nowrap; }
.sla-bar-value { font-size: 11px; color: var(--ink-300); }

.stage-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
.timeline-item { display: flex; gap: 12px; padding: 8px 0; border-left: 2px solid var(--navy-700); margin-left: 5px; padding-left: 16px; position: relative; }
.timeline-marker { position: absolute; left: -6px; top: 12px; width: 10px; height: 10px; border-radius: 50%; background: var(--navy-700); }
.timeline-item--done .timeline-marker { background: var(--status-healthy); }
.timeline-item--current .timeline-marker { background: var(--status-warning); }
.timeline-item--interrupted .timeline-marker { background: var(--status-breach); }
.timeline-item--skipped { opacity: 0.4; }
.timeline-body { flex: 1; }
.timeline-head { display: flex; align-items: center; gap: 8px; }
.timeline-label { font-size: 13px; font-weight: 500; }
.timeline-tag { font-size: 9.5px; color: var(--gold-300); border: 1px solid var(--gold-500); border-radius: 10px; padding: 1px 6px; }
.timeline-dir { font-size: 10px; color: var(--ink-500); margin-left: auto; }
.timeline-meta { font-size: 11.5px; color: var(--ink-300); margin-top: 2px; }
`;

import type { RunTrace, TraceEvent } from "./trace.js";

export interface TraceViewerOptions {
  /** Page title. Default: "SamAI SDK — run {runId}". */
  title?: string;
}

const EVENT_COLORS: Record<string, string> = {
  "run-started": "#5EEAD4",
  "run-resumed": "#5EEAD4",
  "run-completed": "#5EEAD4",
  "run-failed": "#f5716a",
  "model-call": "#7dd3fc",
  "model-call-completed": "#7dd3fc",
  "tool-call": "#c9a4ff",
  "tool-result": "#c9a4ff",
  handoff: "#F5A623",
  retry: "#F5A623",
  fallback: "#F5A623",
  timeout: "#f5716a",
  "guardrail-triggered": "#f5716a",
  "approval-requested": "#F5A623",
  "approval-resolved": "#8fe3a8",
  "voice-turn": "#a78bfa",
  interruption: "#f5716a",
  clarification: "#fbbf24",
  "goal-update": "#34d399",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function summarize(event: TraceEvent): string {
  switch (event.type) {
    case "run-started":
      return event.agentName;
    case "model-call":
      return `${event.agentName} · ${event.model} · turn ${event.turn}`;
    case "model-call-completed":
      return `${event.agentName} · ${event.usage.totalTokens} tokens`;
    case "tool-call":
      return `${event.agentName} · ${event.toolName}(${escapeHtml(JSON.stringify(event.args))})`;
    case "tool-result":
      return `${event.agentName} · ${event.toolName} ${event.isError ? "→ error" : "→ ok"}`;
    case "handoff":
      return `${event.fromAgent} → ${event.toAgent}${event.reason ? ` (${event.reason})` : ""}`;
    case "retry":
      return `${event.agentName} · attempt ${event.attempt} after ${event.delayMs}ms · ${event.error}`;
    case "fallback":
      return `${event.agentName} · ${event.failedProvider} → ${event.nextProvider}`;
    case "timeout":
      return `${event.agentName} · ${event.model} · ${event.timeoutMs}ms`;
    case "guardrail-triggered":
      return `${event.agentName} · ${event.stage} · ${event.reason}`;
    case "approval-requested":
      return `${event.agentName} · ${event.toolName}`;
    case "approval-resolved":
      return `${event.agentName} · ${event.toolName} · ${event.approved ? "approved" : "rejected"}`;
    case "run-completed":
      return "success";
    case "voice-turn":
      return event.agentName + " · " + event.transcript;
    case "interruption":
      return event.agentName + " · " + event.reason;
    case "clarification":
      return event.agentName + " · " + event.question;
    case "goal-update":
      return event.agentName + " · " + event.goal + " (" + event.status + ")";
    case "run-failed":
      return event.error;
    default:
      return "";
  }
}

/**
 * Renders a `RunTrace` as a self-contained, offline-viewable HTML page — a timeline of every
 * model call, tool call, handoff, retry/fallback/timeout, guardrail trip, and approval in the
 * run, proportionally positioned by real elapsed time, with a filterable event list below it.
 *
 * No server, no build step, no external requests — open the file directly in a browser, or
 * serve it however you like (`samai-sdk trace <file.json>` does the latter for you). Good for
 * sharing a specific failing run with a teammate, or just eyeballing what an agent actually did.
 */
export function renderTraceHTML(trace: RunTrace, options: TraceViewerOptions = {}): string {
  const title = options.title ?? `SamAI SDK — run ${trace.runId}`;
  const duration = (trace.finishedAt ?? Date.now()) - trace.startedAt;
  const status = trace.events.some((e) => e.type === "run-failed") ? "failed" : trace.finishedAt ? "completed" : "in progress";
  const statusColor = status === "failed" ? "#f5716a" : status === "completed" ? "#8fe3a8" : "#F5A623";

  const rows = trace.events
    .map((event, i) => {
      const offsetPct = duration > 0 ? ((event.timestamp - trace.startedAt) / duration) * 100 : 0;
      const color = EVENT_COLORS[event.type] ?? "#93a1bd";
      const relMs = event.timestamp - trace.startedAt;
      return `<div class="row" data-type="${event.type}">
        <span class="t">+${relMs}ms</span>
        <span class="dot" style="left:${offsetPct.toFixed(2)}%; background:${color}"></span>
        <span class="tag" style="color:${color}">${event.type}</span>
        <span class="detail">${escapeHtml(summarize(event))}</span>
      </div>`;
    })
    .join("\n");

  const eventTypes = [...new Set(trace.events.map((e) => e.type))];
  const filterButtons = eventTypes
    .map((t) => `<button class="filter-btn active" data-type="${t}" style="--c:${EVENT_COLORS[t] ?? "#93a1bd"}">${t}</button>`)
    .join("\n");

  // Embedded as JSON in the page (not just baked into the DOM above) so a viewer can inspect
  // the full raw trace, or copy it out, without needing devtools gymnastics.
  const traceJson = JSON.stringify(trace, null, 2).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  :root{
    --bg:#0B1120; --bg-raised:#101a2e; --bg-inset:#0a0f1c; --line:#24304a;
    --text:#E5E9F0; --text-dim:#93a1bd; --text-faint:#5b6a8a;
    --mono:"SFMono-Regular","IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  }
  *{box-sizing:border-box;}
  body{margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); font-size:15px; line-height:1.6;}
  .wrap{max-width:980px; margin:0 auto; padding:32px 24px 80px;}
  h1{font-family:var(--mono); font-size:1.3rem; margin:0 0 4px; word-break:break-all;}
  .meta{display:flex; gap:18px; flex-wrap:wrap; color:var(--text-dim); font-size:.85rem; margin-bottom:24px; font-family:var(--mono);}
  .meta b{color:var(--text); font-weight:600;}
  .status{display:inline-flex; align-items:center; gap:6px;}
  .status::before{content:""; width:8px; height:8px; border-radius:50%; background:${statusColor};}
  .timeline{position:relative; height:34px; background:var(--bg-inset); border:1px solid var(--line); border-radius:8px; margin-bottom:20px;}
  .dot{position:absolute; top:50%; width:8px; height:8px; border-radius:50%; transform:translate(-50%,-50%); cursor:pointer;}
  .filters{display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px;}
  .filter-btn{
    font-family:var(--mono); font-size:.7rem; padding:4px 9px; border-radius:100px; cursor:pointer;
    border:1px solid var(--line); background:var(--bg-raised); color:var(--text-dim);
  }
  .filter-btn.active{color:var(--c); border-color:var(--c);}
  .events{border:1px solid var(--line); border-radius:10px; background:var(--bg-inset); overflow:hidden;}
  .row{display:flex; align-items:center; gap:12px; padding:7px 14px; font-family:var(--mono); font-size:.82rem; border-bottom:1px solid var(--line);}
  .row:last-child{border-bottom:none;}
  .row .dot{position:static; transform:none;}
  .t{color:var(--text-faint); width:70px; flex-shrink:0;}
  .tag{width:170px; flex-shrink:0;}
  .detail{color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
  .row.hidden{display:none;}
  details{margin-top:28px;}
  summary{cursor:pointer; color:var(--text-dim); font-family:var(--mono); font-size:.8rem;}
  pre{background:var(--bg-inset); border:1px solid var(--line); border-radius:8px; padding:14px 16px; overflow-x:auto; font-size:.78rem; font-family:var(--mono); color:var(--text-dim);}
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(trace.runId)}</h1>
  <div class="meta">
    <span class="status">${status}</span>
    <span><b>${trace.agentPath.map(escapeHtml).join(" → ")}</b></span>
    <span>${duration}ms</span>
    <span>${trace.totalUsage.totalTokens} tokens (${trace.totalUsage.inputTokens} in / ${trace.totalUsage.outputTokens} out)</span>
    <span>${trace.events.length} events</span>
  </div>

  <div class="timeline" id="timeline">
    ${trace.events
      .map((e) => {
        const offsetPct = duration > 0 ? ((e.timestamp - trace.startedAt) / duration) * 100 : 0;
        const color = EVENT_COLORS[e.type] ?? "#93a1bd";
        return `<span class="dot" style="left:${offsetPct.toFixed(2)}%; background:${color}" title="${escapeHtml(e.type)}"></span>`;
      })
      .join("\n    ")}
  </div>

  <div class="filters" id="filters">
    ${filterButtons}
  </div>

  <div class="events" id="events">
    ${rows}
  </div>

  <details>
    <summary>Raw trace JSON</summary>
    <pre>${escapeHtml(traceJson)}</pre>
  </details>
</div>

<script>
  const buttons = Array.from(document.querySelectorAll('.filter-btn'));
  const rows = Array.from(document.querySelectorAll('.row'));
  function applyFilters(){
    const active = new Set(buttons.filter(b => b.classList.contains('active')).map(b => b.dataset.type));
    rows.forEach(r => r.classList.toggle('hidden', !active.has(r.dataset.type)));
  }
  buttons.forEach(b => b.addEventListener('click', () => { b.classList.toggle('active'); applyFilters(); }));
</script>
</body>
</html>`;
}

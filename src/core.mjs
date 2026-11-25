import fs from "node:fs";
import { ensureStateDirs, isKilled, PATHS, readAgents } from "./config.mjs";
import { loadRules } from "./rules.mjs";
import { proposeAction } from "./gateway.mjs";
import { runAgent } from "./runner.mjs";
import { approveApproval, cancelAllPending, expireStale, listApprovals, publicApproval, rejectApproval } from "./approvals.mjs";
import { listHandoffs } from "./handoffs.mjs";
import { execute, listExecuted } from "./executor.mjs";
import { logActivity, logDecision, readLog } from "./log.mjs";

// What the owner can do, in one place. The CLI and the web page both call
// these functions; agents never do. approve, reject, kill and reset have no
// path from any agent tool.
//
// Built-in tools: the supervisor may only call specialists (Agent); a
// specialist gets none. Every other tool an agent has comes from gateway.mjs
// and is listed in the agent's markdown file.
export const SUPERVISOR_TOOLS = ["Agent"];
export const SPECIALIST_TOOLS = [];

const PICKUP_PROMPT =
  "Handoff run. Process every open handoff addressed to you: list your handoffs, claim each one, do what its Task asks using your records, and complete it with a clear result. Finish with one line per handoff: id and outcome.";

// `signal` lets the owner stop this one run; it is not the kill switch.
export async function ask(text, { signal } = {}) {
  ensureStateDirs();
  expireStale();
  const { supervisor } = readAgents();
  if (isKilled()) {
    return { status: "killed", text: "The kill switch is engaged. Run `npm run reset` to re-enable.", run: null, pending: [], handoffs: [] };
  }
  const before = new Set(listHandoffs().map((h) => h.id));
  const run = await runAgent({ agent: supervisor, prompt: text, tools: SUPERVISOR_TOOLS, maxTurns: 16, signal });
  // The owner's request is a decision too; the page rebuilds the conversation
  // from request + recommendation pairs.
  logDecision({ kind: "request", text: String(text).slice(0, 2000), run: run.run });
  return {
    status: run.status,
    text: run.text,
    run,
    pending: listApprovals({ status: "pending" }).filter((a) => a.run_id === run.run),
    handoffs: listHandoffs().filter((h) => !before.has(h.id)),
  };
}

// A specialist run that picks up the handoffs addressed to it.
export async function pickup(agent, { signal } = {}) {
  ensureStateDirs();
  expireStale();
  const { specialists } = readAgents();
  if (agent && !specialists.includes(agent)) {
    throw new Error(`"${agent}" is not a specialist. Known specialists: ${specialists.join(", ")}`);
  }
  if (isKilled()) return { status: "killed", results: [] };
  const targets = agent ? [agent] : specialists.filter((s) => listHandoffs({ status: "open", to: s }).length > 0);
  const results = [];
  for (const name of targets) {
    const run = await runAgent({ agent: name, prompt: PICKUP_PROMPT, tools: SPECIALIST_TOOLS, maxTurns: 14, signal });
    results.push({ agent: name, run, open_after: listHandoffs({ status: "open", to: name }).length });
  }
  return { status: "success", results };
}

export function approve({ id, code }) {
  expireStale();
  const r = approveApproval({ id, code });
  if (!r.ok) return r;
  return { ...r, execution: execute(r.approval.action, { approval: r.approval }) };
}

export const reject = ({ id }) => rejectApproval({ id });

// Owner channel only: the one-time code is in these records.
export function pending() {
  expireStale();
  return listApprovals({ status: "pending" });
}

// Direct action proposal without an agent. Used by the tests to exercise the
// gate on its own; the owner's CLI does not expose it.
export const propose = (action) => proposeAction(action, { rules: loadRules() });

export function kill() {
  ensureStateDirs();
  fs.writeFileSync(PATHS.killFlag, `${new Date().toISOString()}\n`);
  const cancelled = cancelAllPending("kill_switch");
  logActivity("kill_switch_engaged", { cancelled: cancelled.length });
  return { cancelled };
}

export function reset() {
  if (fs.existsSync(PATHS.killFlag)) fs.unlinkSync(PATHS.killFlag);
  logActivity("kill_switch_released");
}

export function status() {
  expireStale();
  const runs = readLog("runs.jsonl");
  const byStatus = {};
  const perAgent = {};
  for (const r of runs) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    // A subagent reports one combined token count (unsplit_tokens); the main
    // agent reports input and output separately.
    const entries = Object.entries(r.usage ?? {}).map(([agent, u]) => [agent, { ...u, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.unsplit_tokens ?? 0) }]);
    const total = entries.reduce((sum, [, u]) => sum + u.tokens, 0);
    for (const [agent, u] of entries) {
      const a = (perAgent[agent] ??= { runs: 0, api_calls: 0, tool_uses: 0, input_tokens: 0, output_tokens: 0, unsplit_tokens: 0, tokens: 0, notional_usd: 0 });
      a.runs += 1;
      a.api_calls += u.api_calls ?? 0;
      a.tool_uses += u.tool_uses ?? 0;
      a.input_tokens += u.input_tokens ?? 0;
      a.output_tokens += u.output_tokens ?? 0;
      a.unsplit_tokens += u.unsplit_tokens ?? 0;
      a.tokens += u.tokens;
      // The SDK's cost figure is per run; an agent's share of it is its share
      // of the run's tokens.
      a.notional_usd += (r.cost_usd_notional ?? 0) * (total ? u.tokens / total : 0);
    }
  }
  for (const a of Object.values(perAgent)) a.notional_usd = Number(a.notional_usd.toFixed(4));
  return {
    killed: isKilled(),
    runs: { total: runs.length, by_status: byStatus },
    errors: runs.filter((r) => r.status === "error").map((r) => ({ run: r.run, agent: r.agent, errors: r.errors })),
    per_agent: perAgent,
    pending_approvals: listApprovals({ status: "pending" }).map(publicApproval),
    open_handoffs: listHandoffs({ status: "open" }).map((h) => ({ id: h.id, from: h.from, to: h.to, title: h.title })),
    executed: listExecuted().length,
  };
}

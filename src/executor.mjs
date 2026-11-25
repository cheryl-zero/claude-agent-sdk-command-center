import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";
import { logActivity, logDecision, uid } from "./log.mjs";

// The only place an action turns into a result. For this sample every
// executor is a simulation: it writes a log line and has no effect outside the
// folder. Real integrations plug in here, one function per action type.
const usd = (n) => `${Number(n).toLocaleString("en-US")} USD`;

const SIMULATIONS = {
  payment: (a) => `pay ${usd(a.amount_usd)} to ${a.recipient ?? "the recipient"} — "${a.title}". No money moved.`,
  send_message: (a) => `send "${a.title}" to ${a.recipient ?? "the recipient"}. Nothing was sent.`,
  change_access: (a) => `change access — "${a.title}"${a.recipient ? ` for ${a.recipient}` : ""}. Nothing was changed.`,
  calendar_entry: (a) => `add the calendar entry "${a.title}". Nothing was written.`,
};

export function execute(action, { approval = null, run = null } = {}) {
  const detail = `SIMULATED: ${(SIMULATIONS[action.type] ?? ((a) => a.title))(action)}`;
  const record = { ts: new Date().toISOString(), id: uid("EX"), action, simulated: true, detail, approval_id: approval?.id ?? null };
  fs.mkdirSync(PATHS.logs, { recursive: true });
  fs.appendFileSync(path.join(PATHS.logs, "executed.jsonl"), `${JSON.stringify(record)}\n`);
  logActivity("action_executed", { execution: record.id, action: action.type, title: action.title, approval: approval?.id ?? null, run });
  logDecision({ kind: "action_executed", action: action.type, title: action.title, amount_usd: action.amount_usd ?? null, approval: approval?.id ?? null, run });
  return record;
}

export function listExecuted() {
  const file = path.join(PATHS.logs, "executed.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

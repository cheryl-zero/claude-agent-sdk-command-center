import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.mjs";
import { logActivity, uid } from "./log.mjs";

// A pending approval is a file. It can be decided only through approveApproval
// and rejectApproval, which the owner's channels call (CLI, web page). No agent
// holds a tool that reaches this module.
//
// Guarantees:
//   - the one-time code is generated here and never shown to an agent;
//   - a wrong code is refused, and three wrong codes void the approval;
//   - an approval expires, works once, and is void if the stored action changes.
const now = () => new Date().toISOString();
const fileOf = (id) => path.join(PATHS.approvals, `${id}.json`);
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
// "4-7-2-9", "4 7 2 9" and "4729" all read as the same code.
const digits = (code) => String(code ?? "").replace(/\D/g, "");

function write(rec) {
  fs.mkdirSync(PATHS.approvals, { recursive: true });
  fs.writeFileSync(fileOf(rec.id), JSON.stringify(rec, null, 2));
}

export function createApproval({ action, rule, policy, run = null }) {
  const rec = {
    id: uid("AP"),
    action,
    action_hash: sha(action),
    rule,
    status: "pending",
    code: String(crypto.randomInt(0, 10000)).padStart(4, "0"),
    max_wrong_attempts: policy.maxWrongAttempts,
    wrong_attempts: 0,
    created_at: now(),
    expires_at: new Date(Date.now() + policy.expiresSeconds * 1000).toISOString(),
    decided_at: null,
    decided_by: null,
    run_id: run,
  };
  write(rec);
  return rec;
}

export function getApproval(id) {
  const file = fileOf(id);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export function listApprovals({ status } = {}) {
  if (!fs.existsSync(PATHS.approvals)) return [];
  return fs
    .readdirSync(PATHS.approvals)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PATHS.approvals, f), "utf8")))
    .filter((a) => !status || a.status === status)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// What agents, logs and the web page may see: the same record without the code.
export function publicApproval(rec) {
  if (!rec) return rec;
  const { code, ...rest } = rec;
  return rest;
}

export const displayCode = (code) => digits(code).split("").join("-");

export function approveApproval({ id, code, by = "owner" }) {
  const rec = getApproval(id);
  if (!rec) return { ok: false, reason: "not_found" };
  if (rec.status !== "pending") {
    logActivity("approval_refused", { approval: id, by, reason: `not_pending:${rec.status}` });
    return { ok: false, reason: `not_pending:${rec.status}` };
  }
  if (Date.now() > Date.parse(rec.expires_at)) {
    rec.status = "expired";
    rec.decided_at = now();
    write(rec);
    logActivity("approval_expired", { approval: id });
    return { ok: false, reason: "expired" };
  }
  if (sha(rec.action) !== rec.action_hash) {
    rec.status = "void";
    rec.decided_at = now();
    write(rec);
    logActivity("approval_voided", { approval: id, reason: "action_changed" });
    return { ok: false, reason: "action_changed" };
  }
  if (digits(code) !== rec.code) {
    rec.wrong_attempts += 1;
    const exhausted = rec.wrong_attempts >= rec.max_wrong_attempts;
    if (exhausted) {
      rec.status = "void";
      rec.decided_at = now();
    }
    write(rec);
    logActivity("approval_refused", {
      approval: id,
      by,
      attempt: rec.wrong_attempts,
      reason: exhausted ? "wrong_code_attempts_exhausted" : "wrong_code",
    });
    return { ok: false, reason: exhausted ? "wrong_code_attempts_exhausted" : "wrong_code" };
  }
  rec.status = "approved";
  rec.decided_at = now();
  rec.decided_by = by;
  write(rec);
  logActivity("approval_given", { approval: id, by, action: rec.action.type });
  return { ok: true, approval: rec };
}

export function rejectApproval({ id, by = "owner" }) {
  const rec = getApproval(id);
  if (!rec) return { ok: false, reason: "not_found" };
  if (rec.status !== "pending") return { ok: false, reason: `not_pending:${rec.status}` };
  rec.status = "rejected";
  rec.decided_at = now();
  rec.decided_by = by;
  write(rec);
  logActivity("approval_rejected", { approval: id, by, action: rec.action.type });
  return { ok: true, approval: rec };
}

export function expireStale() {
  let count = 0;
  for (const rec of listApprovals({ status: "pending" })) {
    if (Date.now() > Date.parse(rec.expires_at)) {
      rec.status = "expired";
      rec.decided_at = now();
      write(rec);
      logActivity("approval_expired", { approval: rec.id });
      count += 1;
    }
  }
  return count;
}

export function cancelAllPending(reason) {
  const cancelled = [];
  for (const rec of listApprovals({ status: "pending" })) {
    rec.status = "cancelled";
    rec.decided_at = now();
    rec.decided_by = "kill_switch";
    write(rec);
    logActivity("approval_cancelled", { approval: rec.id, reason });
    cancelled.push(publicApproval(rec));
  }
  return cancelled;
}

import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PATHS, ensureStateDirs, isKilled } from "./config.mjs";
import { approvalPolicy, classify } from "./rules.mjs";
import { createApproval, publicApproval } from "./approvals.mjs";
import { claimHandoff, completeHandoff, createHandoff, listHandoffs } from "./handoffs.mjs";
import { execute } from "./executor.mjs";
import { logActivity, logDecision } from "./log.mjs";

// Agents have no built-in file, shell or browser tools. Everything an agent
// can do goes through a small tool server built here, one per agent and named
// after it. Each agent's markdown file lists the tools it may call.
//
//   supervisor  → propose_action, create_handoff, list_handoffs, shared context
//   specialist  → list_records, read_record, list_handoffs, claim_handoff, complete_handoff
//
// A specialist's tools only reach its own records folder (data/<name>/) and
// always act as that specialist. No agent, in any run, gets a tool that
// approves, rejects or releases the kill switch: those live in core.mjs and
// are reached only by the owner. The .env file and the approval records are
// not reachable from any tool.
const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });

const actionShape = {
  type: z.enum(["payment", "send_message", "change_access", "calendar_entry"]),
  title: z.string().min(3).max(120).describe("Short name of the action, e.g. 'Pay invoice INV-1042'"),
  summary: z.string().min(3).describe("What exactly will happen, in one sentence. This is read back to the owner."),
  amount_usd: z.number().nonnegative().optional().describe("Amount in USD; required for a payment"),
  recipient: z.string().optional().describe("Who or what receives the payment, message or access change; required for a payment"),
};

// The single entry point for an action. Used by the propose_action tool and
// called directly by the tests.
export function proposeAction(action, { rules, run = null }) {
  if (isKilled()) return { outcome: "refused", reason: "kill_switch_engaged" };
  if (action.type === "payment" && (!(Number(action.amount_usd) > 0) || !action.recipient)) {
    return { outcome: "refused", reason: "payment_needs_amount_and_recipient" };
  }
  const { risk, rule } = classify(action, rules);
  logActivity("action_proposed", { action: action.type, title: action.title, amount_usd: action.amount_usd ?? null, risk, rule, run });
  if (risk === "low") {
    const execution = execute(action, { run });
    return { outcome: "executed", simulated: true, detail: execution.detail, rule };
  }
  const approval = createApproval({ action, rule, policy: approvalPolicy(rules), run });
  logActivity("approval_pending", {
    approval: approval.id,
    action: action.type,
    title: action.title,
    amount_usd: action.amount_usd ?? null,
    risk,
    rule,
    run,
  });
  logDecision({
    kind: "action_pending_approval",
    action: action.type,
    title: action.title,
    amount_usd: action.amount_usd ?? null,
    approval: approval.id,
    run,
  });
  return { outcome: "pending_approval", approval: publicApproval(approval), rule };
}

const printHandoff = (h) =>
  `[${h.status}] ${h.id} to: ${h.to} — ${h.title}\nTask: ${h.body.task}\nResult: ${h.body.result || "_pending_"}`;

export function createSupervisorGateway({ supervisor, specialists, rules, run = null }) {
  const tools = [
    tool("list_handoffs", "List recorded handoffs. Optional filters: status (open, claimed, done) and the specialist they are addressed to.", { status: z.enum(["open", "claimed", "done"]).optional(), to: z.string().optional() },
      async (a) => {
        const items = listHandoffs(a);
        logActivity("handoff_listed", { agent: supervisor, count: items.length, run });
        return text(items.length ? items.map(printHandoff).join("\n\n") : "No handoffs found.");
      }),
    tool("propose_action", "Propose one action for the owner. The rules file decides: an action in the 'auto' list runs on its own and is logged; everything else (spending, sending, access changes) stops and waits for the owner. You cannot approve anything yourself.", actionShape,
      async (a) => {
        try {
          const r = proposeAction(a, { rules, run });
          if (r.outcome === "executed") return text(`EXECUTED (simulated): ${r.detail}`);
          if (r.outcome === "pending_approval") {
            return text(`PENDING_APPROVAL ${r.approval.id} — "${a.title}" is waiting for the owner. Tell the owner exactly what will happen, then stop. You cannot approve this, and you must not say or imply that the owner approved.`);
          }
          return fail(`REFUSED: ${r.reason}`);
        } catch (e) {
          return fail(`REFUSED: ${e.message}`);
        }
      }),
    tool("create_handoff", "Record a handoff for a specialist to pick up on their next run. Use it when the owner says 'later', when the answer is not needed now, or when the work does not have to happen in this conversation.", { to: z.enum(specialists), title: z.string().min(3).max(120), task: z.string().min(10).describe("Self-contained instructions with every detail the specialist needs; they do not see this conversation"), context: z.string().optional() },
      async (a) => {
        try {
          const h = createHandoff({ ...a, from: supervisor, specialists, run });
          return text(`RECORDED ${h.id} for ${h.to}: "${h.title}". It is picked up on the next ${h.to} run.`);
        } catch (e) {
          return fail(`REFUSED: ${e.message}`);
        }
      }),
    tool("read_shared_context", "Read the shared context that every agent can read.", {}, async () =>
      text(fs.existsSync(PATHS.shared) ? fs.readFileSync(PATHS.shared, "utf8") : "_empty_"),
    ),
    tool("add_shared_note", "Append one short note to the shared context so the other agents can use it.", { note: z.string().min(3).max(500) },
      async ({ note }) => {
        ensureStateDirs();
        const line = `- ${new Date().toISOString()} · ${supervisor}: ${String(note).replace(/\s+/g, " ").trim().slice(0, 500)}\n`;
        fs.appendFileSync(PATHS.shared, line);
        logActivity("shared_note_added", { agent: supervisor, run });
        return text("Note added to the shared context.");
      }),
  ];
  return createSdkMcpServer({ name: "supervisor", tools });
}

const recordsDir = (name) => path.join(PATHS.data, name);
const recordFiles = (name) => {
  const dir = recordsDir(name);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
};

// Built from the agent file list, so a new specialist file plus a data folder
// gives a new tool server without a code change.
export function createSpecialistGateway({ name, run = null }) {
  const tools = [
    tool("list_records", `List the record files in your records folder (data/${name}/).`, {}, async () => {
      const files = recordFiles(name);
      logActivity("records_listed", { agent: name, count: files.length, run });
      return text(files.length ? files.join("\n") : "Your records folder is empty.");
    }),
    tool("read_record", "Read one of your record files, by its exact file name.", { file: z.string() }, async ({ file }) => {
      // Only a file name from this specialist's own folder; no paths.
      if (!recordFiles(name).includes(file)) return fail("REFUSED: that file is not in your records folder.");
      logActivity("record_read", { agent: name, file, run });
      return text(fs.readFileSync(path.join(recordsDir(name), file), "utf8").slice(0, 20000));
    }),
    tool("list_handoffs", "List recorded handoffs addressed to you. Optional filter: status (open, claimed, done).", { status: z.enum(["open", "claimed", "done"]).optional() },
      async (a) => {
        const items = listHandoffs({ ...a, to: name });
        logActivity("handoff_listed", { agent: name, count: items.length, run });
        return text(items.length ? items.map(printHandoff).join("\n\n") : "No handoffs addressed to you.");
      }),
    tool("claim_handoff", "Claim an open handoff addressed to you.", { id: z.string() }, async ({ id }) => {
      const r = claimHandoff({ id, by: name });
      return r.ok ? text(`CLAIMED ${id}: ${r.handoff.title}\nTask: ${r.handoff.body.task}\nContext: ${r.handoff.body.context || "_none_"}`) : fail(`REFUSED: ${r.reason}`);
    }),
    tool("complete_handoff", "Complete a handoff you have claimed, with your result.", { id: z.string(), result: z.string().min(10) }, async ({ id, result }) => {
      const r = completeHandoff({ id, by: name, result });
      return r.ok ? text(`COMPLETED ${id}.`) : fail(`REFUSED: ${r.reason}`);
    }),
  ];
  return createSdkMcpServer({ name, tools });
}

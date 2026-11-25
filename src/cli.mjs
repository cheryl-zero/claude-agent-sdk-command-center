import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayCode } from "./approvals.mjs";
import * as core from "./core.mjs";

const USAGE = `adam-command-center

  npm run ask -- "<say something to Adam>"     talk to the supervisor (text in, one recommendation out)
  npm run pickup -- [specialist]               run a specialist so it picks up its recorded handoffs
  npm run pending                              list approvals waiting for you (with their one-time codes)
  npm run approve -- <id> <code>               approve one pending action with its code
  npm run reject -- <id>                       reject one pending action
  npm run kill                                 kill switch: stops runs, cancels every pending approval
  npm run reset                                release the kill switch
  npm run status                               runs, errors and cost per agent
  npm run serve                                open the web command center
  npm test                                     end-to-end tests`;

const card = (a) => {
  const left = Math.max(0, Math.round((Date.parse(a.expires_at) - Date.now()) / 1000));
  return [
    `  ${a.id}  ${a.action.type}: ${a.action.title}`,
    `    What will happen: ${a.action.summary}`,
    `    Rule: ${a.rule} · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`,
    `    Approve: npm run approve -- ${a.id} ${a.code}      Reject: npm run reject -- ${a.id}`,
  ].join("\n");
};

const json = (value) => JSON.stringify(value, null, 2);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "ask": {
      const text = rest.join(" ").trim();
      if (!text) return console.log(USAGE);
      const r = await core.ask(text);
      console.log(`\nAdam:\n${r.text}\n`);
      for (const h of r.handoffs) {
        console.log(`RECORDED HANDOFF ${h.id} → ${h.to}: ${h.title}  (picked up on the next ${h.to} run)`);
      }
      const pending = core.pending().filter((a) => a.run_id === r.run?.run);
      if (pending.length) {
        console.log("\nPENDING YOUR APPROVAL — say or type the code:");
        for (const a of pending) {
          console.log(card(a));
          console.log(`    One-time code: ${displayCode(a.code)}`);
        }
        console.log();
      }
      if (r.status !== "success" && r.status !== "killed") process.exitCode = 1;
      break;
    }
    case "pending": {
      const items = core.pending();
      if (!items.length) return console.log("Nothing is waiting for approval.");
      for (const a of items) {
        console.log(card(a));
        console.log(`    One-time code: ${displayCode(a.code)}\n`);
      }
      break;
    }
    case "pickup": {
      const r = await core.pickup(rest[0]);
      if (r.status === "killed") return console.log(r.text ?? "The kill switch is engaged.");
      for (const x of r.results) {
        console.log(`\n${x.agent} — ${x.run.status} · ${x.run.duration_ms} ms · open handoffs left: ${x.open_after}\n${x.run.text}`);
      }
      if (r.results.some((x) => x.run.status !== "success")) process.exitCode = 1;
      break;
    }
    case "approve": {
      const [id, code] = rest;
      if (!id || code === undefined) return console.log('Usage: npm run approve -- <id> <code>');
      const r = core.approve({ id, code });
      console.log(r.ok ? `APPROVED ${id}\n${r.execution.detail}` : `REFUSED: ${r.reason}`);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "reject": {
      const [id] = rest;
      if (!id) return console.log("Usage: npm run reject -- <id>");
      const r = core.reject({ id });
      console.log(r.ok ? `REJECTED ${id} — ${r.approval.action.title}. Nothing was done.` : `REFUSED: ${r.reason}`);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "kill": {
      const r = core.kill();
      console.log(`KILL SWITCH ENGAGED. Pending approvals cancelled: ${r.cancelled.length}. Runs in progress stop at their next event.`);
      for (const a of r.cancelled) console.log(`  cancelled ${a.id}  ${a.action.title}`);
      break;
    }
    case "reset": {
      core.reset();
      console.log("Kill switch released.");
      break;
    }
    case "status": {
      console.log(json(core.status()));
      break;
    }
    case "serve": {
      await import("./server.mjs");
      break;
    }
    default:
      console.log(USAGE);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => {
      // A stopped run leaves the SDK shutting the agent process down in the
      // background; the command itself is finished.
      if (process.argv[2] !== "serve") process.exit(process.exitCode ?? 0);
    })
    .catch((err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    });
}

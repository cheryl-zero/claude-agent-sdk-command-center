import { query } from "@anthropic-ai/claude-agent-sdk";
import { APP_DIR, childEnv, isKilled, readAgents } from "./config.mjs";
import { loadRules } from "./rules.mjs";
import { createSpecialistGateway, createSupervisorGateway } from "./gateway.mjs";
import { logActivity, logDecision, logRun, uid } from "./log.mjs";

// Starts one agent run on the Claude Agent SDK and turns its message stream
// into log lines. The agent itself comes from its markdown file; this module
// wires the tool servers, logs what happens, and stops the run if the kill
// switch is engaged.
//
// Agents get no built-in tools except the supervisor's Agent tool. Everything
// else is a tool server from gateway.mjs, and each agent's markdown file
// lists which of those tools it may call.
// One plain-language line per tool call, for the activity log and the page.
function summarizeCall(block) {
  const input = block.input ?? {};
  const name = block.name.startsWith("mcp__") ? block.name.slice(5).split("__")[1] : block.name;
  switch (name) {
    case "Agent":
      return `calls ${input.subagent_type ?? input.agent_type ?? "?"}: ${String(input.description ?? input.prompt ?? "").slice(0, 80)}`;
    case "propose_action":
      return `proposes ${input.type}: ${input.title}`;
    case "create_handoff":
      return `records a handoff for ${input.to}: ${input.title}`;
    case "list_handoffs":
      return "lists handoffs";
    case "read_shared_context":
      return "reads the shared context";
    case "add_shared_note":
      return "adds a shared note";
    case "list_records":
      return "lists its records";
    case "read_record":
      return `reads ${input.file}`;
    case "claim_handoff":
      return `claims ${input.id}`;
    case "complete_handoff":
      return `completes ${input.id}`;
    default:
      return name;
  }
}

// The SDK reports tokens per run, not per message: the result carries the main
// agent's totals and each subagent's closing event carries its own total.
const emptyUsage = () => ({ api_calls: 0, input_tokens: 0, output_tokens: 0, unsplit_tokens: 0, tool_uses: 0 });

export async function runAgent({ agent, prompt, tools, maxTurns = 16, signal }) {
  const { supervisor, specialists } = readAgents();
  const rules = loadRules();
  const run = uid("RUN");
  const started = Date.now();
  const abort = new AbortController();
  const names = new Map(); // subagent task_id → agent name
  const usage = {}; // agent name → tokens
  const toolCalls = [];
  let result = null;
  let failure = null;
  let stoppedByOwner = false;
  const onOwnerStop = () => {
    stoppedByOwner = true;
    abort.abort();
  };
  signal?.addEventListener("abort", onOwnerStop, { once: true });

  // Every run gets every server, so a specialist called as a subagent finds
  // its own tools. Which tools an agent may call is set in its markdown file.
  const mcpServers = {
    supervisor: createSupervisorGateway({ supervisor, specialists, rules, run }),
    ...Object.fromEntries(specialists.map((name) => [name, createSpecialistGateway({ name, run })])),
  };
  const serverRules = Object.keys(mcpServers).map((name) => `mcp__${name}`);

  logActivity("run_started", { run, agent });
  const io = query({
    prompt,
    options: {
      agent,
      cwd: APP_DIR,
      env: childEnv(),
      settingSources: ["project"],
      tools,
      allowedTools: serverRules,
      mcpServers,
      permissionMode: "default",
      abortController: abort,
      maxTurns,
    },
  });

  // The kill switch is a file, so it works across processes. It is checked
  // between messages too, so a run waiting on a slow model call still stops
  // at once; the SDK then shuts the agent process down on its own.
  let stopped;
  const stoppedP = new Promise((resolve) => (stopped = resolve));
  abort.signal.addEventListener("abort", stopped);
  const watcher = setInterval(() => {
    if (isKilled()) abort.abort();
  }, 250);

  const ended = (async () => {
    try {
      for await (const m of io) {
        if (isKilled()) {
          abort.abort();
          break;
        }
        if (m.type === "system" && m.task_id && m.subagent_type) {
          if (!names.has(m.task_id)) {
            names.set(m.task_id, m.subagent_type);
            logActivity("agent_started", { run, agent: m.subagent_type, task: m.task_id, by: agent });
          }
        }
        // task_notification closes a subagent but does not repeat its name.
        if (m.type === "system" && m.subtype === "task_notification" && names.has(m.task_id)) {
          const name = names.get(m.task_id);
          const u = (usage[name] ??= emptyUsage());
          u.unsplit_tokens += m.usage?.total_tokens ?? 0;
          u.tool_uses += m.usage?.tool_uses ?? 0;
          logActivity("agent_finished", {
            run,
            agent: name,
            task: m.task_id,
            status: m.status,
            tokens: m.usage?.total_tokens ?? null,
          });
        }
        if (m.type === "assistant") {
          const who = m.agent_id ? (names.get(m.agent_id) ?? "subagent") : agent;
          for (const b of m.message?.content ?? []) {
            if (b.type !== "tool_use") continue;
            const call = { run, agent: who, tool: b.name.replace(/^mcp__/, ""), brief: summarizeCall(b) };
            toolCalls.push(call);
            logActivity("tool_call", call);
          }
        }
        if (m.type === "result") result = m;
      }
    } catch (err) {
      failure = String(err?.message ?? err);
      logActivity("error", { run, agent, error: failure });
    }
  })();

  await Promise.race([ended, stoppedP]);
  clearInterval(watcher);
  signal?.removeEventListener("abort", onOwnerStop);

  if (result) {
    const main = (usage[agent] ??= emptyUsage());
    main.api_calls = result.num_turns ?? 0;
    main.input_tokens =
      (result.usage?.input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0) + (result.usage?.cache_read_input_tokens ?? 0);
    main.output_tokens = result.usage?.output_tokens ?? 0;
    main.tool_uses = toolCalls.filter((c) => c.agent === agent).length;
  }
  const killed = isKilled();
  const status = killed
    ? "killed"
    : stoppedByOwner
      ? "stopped"
      : failure
        ? "error"
        : result?.subtype === "success"
          ? "success"
          : (result?.subtype ?? "error");
  const summary = {
    run,
    agent,
    status,
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    turns: result?.num_turns ?? 0,
    usage,
    // The SDK's own estimate at list prices. On a plan or a third-party
    // endpoint this is not what anyone is billed.
    cost_usd_notional: result?.total_cost_usd ?? null,
    permission_denials: (result?.permission_denials ?? []).map((d) => d.tool_name),
    errors: failure ? [failure] : (result?.errors ?? []),
  };
  logRun(summary);
  logActivity("run_finished", { run, agent, status });
  if (status === "success" && agent === supervisor) {
    logDecision({ kind: "recommendation", text: String(result.result).slice(0, 2000), run });
  }
  return { ...summary, text: killed || stoppedByOwner ? "" : String(result?.result ?? ""), toolCalls };
}

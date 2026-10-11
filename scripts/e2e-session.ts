// End-to-end proof of the persistent-session path using a real tmux pane.
// Does NOT require a Telegram token. Run: npx tsx scripts/e2e-session.ts
import { loadConfig } from "../src/config/config";
import { LogHub } from "../src/logger/logger";
import { DB } from "../src/db/database";
import { EventBus } from "../src/core/event-bus";
import { Tmux } from "../src/session/tmux";
import { AdapterRegistry } from "../src/adapters/registry";
import { SessionManager } from "../src/session/session-manager";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig("config/config.yaml");
  const logs = new LogHub("./logs");
  const db = new DB("./data/e2e.db");
  const bus = new EventBus(db);
  const tmux = new Tmux(cfg.sessions.tmux_prefix);
  const adapters = new AdapterRegistry({ ...cfg.agents, shell: { enabled: true, command: "bash" } });
  const mgr = new SessionManager(db, bus, tmux, adapters, logs, cfg);

  if (!(await tmux.available())) {
    console.error("✗ tmux is not installed — aborting e2e test.");
    process.exit(2);
  }

  const events: string[] = [];
  bus.on("event", (e) => events.push(e.type));

  const s = await mgr.create({ name: "e2e-shell", project_id: null, agent: "shell", cwd: process.cwd() });
  await mgr.start(s.id, "echo HELLO_FROM_AGENT; echo 'Waiting? yes/no'");
  console.log(`✓ session #${s.id} started, status=${db.getSession(s.id)!.status}`);

  await sleep(2500);
  const out1 = await mgr.capture(s.id, 50);
  console.log("— captured output contains HELLO_FROM_AGENT:", out1.includes("HELLO_FROM_AGENT"));

  await mgr.sendInput(s.id, "echo SECOND_LINE");
  await sleep(1500);
  const out2 = await mgr.capture(s.id, 50);
  console.log("— after sendInput contains SECOND_LINE:", out2.includes("SECOND_LINE"));

  await mgr.stop(s.id);
  console.log(`✓ stopped, final status=${db.getSession(s.id)!.status}`);
  console.log("— emitted events:", [...new Set(events)].join(", "));

  await tmux.killSession(String(s.id));
  db.close();
  logs.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

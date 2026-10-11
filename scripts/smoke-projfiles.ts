import { LocalRunner } from "../src/exec/local-runner";
import { ProjectFiles } from "../src/session/project-files";
import fs from "node:fs";

async function main() {
  const root = "/tmp/proj-test";
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const runner = new LocalRunner();
  const tracker: any = { report: (m: string, e: unknown) => console.log("tracker:", m, String(e)) };
  const pf = new ProjectFiles(runner, tracker);

  console.log("empty memory:", (await pf.readMemory(root)).length);
  await pf.upsertMemory(root, { session_id: 1, agent: "qoder", task: "build api", status: "STARTED" });
  await pf.upsertMemory(root, { session_id: 2, agent: "shell", task: "run tests", status: "STARTED" });
  await pf.upsertMemory(root, { session_id: 1, status: "FINISHED", summary: "done: api server" });
  const m = await pf.readMemory(root);
  console.log(JSON.stringify(m, null, 1));

  // corrupt file → self-heal on next upsert
  fs.writeFileSync(pf.memoryPath(root), "{not json");
  await pf.upsertMemory(root, { session_id: 3, agent: "qoder", task: "t3", status: "STARTED" });
  const m2 = await pf.readMemory(root);
  console.log("after corruption, entries:", m2.length, "first:", m2[0]?.session_id);

  // pipe-pane locally
  const { Tmux } = await import("../src/session/tmux");
  const tmux = new Tmux("teleops-test", runner);
  if (await tmux.available()) {
    const logPath = `${pf.logDir(root)}/pipe-test.log`;
    await pf.ensureLogDir(root);
    await tmux.newSession("pipetest", root, "echo HELLO-FROM-PANE");
    const ok = await tmux.pipePane("pipetest", Tmux.appendToShell(logPath));
    console.log("pipe-pane ok:", ok);
    await tmux.sendInput("pipetest", "echo second-line");
    await new Promise((r) => setTimeout(r, 800));
    await tmux.killSession("pipetest");
    console.log("log file:", fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(0, 4) : "MISSING");
    console.log("size:", await pf.fileSize(logPath));
  } else {
    console.log("no local tmux, skipping pipe test");
  }
  process.exit(0);
}
main();

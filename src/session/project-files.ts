import { shq } from "../exec/exec-runner";
import type { ExecRunner } from "../exec/exec-runner";
import type { ModuleErrorTracker } from "../core/error-tracker";

export interface MemoryEntry {
  ts: string;
  session_id: number;
  agent: string;
  task: string;
  status: string;
  summary: string;
}

const MEMORY_CAP = 20;

/**
 * Owns the `.teleops/` folder inside each project (on the project's host):
 * logs/ for per-session pipe-pane output, memory.json for the last tasks.
 * Single TeleOps instance owns these files, so read-modify-write is done
 * without locking. All failures report to the tracker, never throw into the
 * session lifecycle.
 */
export class ProjectFiles {
  constructor(
    private runner: ExecRunner,
    private tracker: ModuleErrorTracker,
  ) {}

  logDir(projectRoot: string): string {
    return `${projectRoot}/.teleops/logs`;
  }

  memoryPath(projectRoot: string): string {
    return `${projectRoot}/.teleops/memory.json`;
  }

  async ensureLogDir(projectRoot: string): Promise<void> {
    const r = await this.runner.exec("mkdir", ["-p", this.logDir(projectRoot)]);
    if (r.code !== 0)
      this.tracker.report("session", r.stderr || "mkdir .teleops/logs failed", {
        project: projectRoot,
      });
  }

  async readMemory(projectRoot: string): Promise<MemoryEntry[]> {
    const r = await this.runner.exec("cat", [this.memoryPath(projectRoot)]);
    if (r.code !== 0 || !r.stdout.trim()) return [];
    try {
      const parsed = JSON.parse(r.stdout) as { entries?: MemoryEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      // self-healing: only TeleOps writes this file; corruption starts fresh
      this.tracker.report("session", "memory.json unreadable — starting fresh", {
        project: projectRoot,
      });
      return [];
    }
  }

  /** Insert/update entry for session_id (newest first, capped) and write back atomically. */
  async upsertMemory(
    projectRoot: string,
    entry: Pick<MemoryEntry, "session_id"> & Partial<Omit<MemoryEntry, "session_id">>,
  ): Promise<void> {
    const entries = await this.readMemory(projectRoot);
    const idx = entries.findIndex((e) => e.session_id === entry.session_id);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx]!, ...entry } as MemoryEntry;
    } else {
      entries.unshift({
        ts: new Date().toISOString(),
        session_id: entry.session_id,
        agent: entry.agent ?? "?",
        task: entry.task ?? "",
        status: entry.status ?? "STARTED",
        summary: entry.summary ?? "",
      });
    }
    const kept = entries.slice(0, MEMORY_CAP);
    const json = JSON.stringify({ updated_at: new Date().toISOString(), entries: kept }, null, 2);
    const target = this.memoryPath(projectRoot);
    const tmp = `${target}.tmp`;
    const mk = await this.runner.exec("mkdir", ["-p", `${projectRoot}/.teleops`]);
    if (mk.code !== 0) {
      this.tracker.report("session", mk.stderr || "mkdir .teleops failed", { project: projectRoot });
      return;
    }
    const w = await this.runner.execScript(`cat > ${shq(tmp)}`, { input: json });
    if (w.code !== 0) {
      this.tracker.report("session", w.stderr || "memory.json write failed", { project: projectRoot });
      return;
    }
    const mv = await this.runner.exec("mv", ["-f", tmp, target]);
    if (mv.code !== 0)
      this.tracker.report("session", mv.stderr || "memory.json rename failed", { project: projectRoot });
  }

  async fileSize(pathOnHost: string): Promise<number | null> {
    const r = await this.runner.exec("stat", ["-c", "%s", pathOnHost]);
    if (r.code !== 0) return null;
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
}

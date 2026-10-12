import http from "node:http";
import { App } from "../core/container";
import { OutputHub } from "./output-hub";
import { TerminalService } from "./terminal-service";
import { validateInitData } from "./telegram-init-data";
import { MINI_APP_HTML } from "./mini-app-page";
import {
  DENY_MESSAGE,
  accessibleProjects,
  accessibleSessions,
  isAdminUser,
  isAllowedUser,
  redactSecrets,
  resolveProject,
  resolveSession,
} from "../auth/access";
import { DomainEvent } from "../shared/types";

/**
 * Mini App HTTP surface for the Live Session Terminal.
 *
 * Trust model:
 *  - every /api/* request must carry `X-Telegram-Init-Data`, validated with
 *    the bot token HMAC (src/web/telegram-init-data). The raw initData never
 *    appears in URLs, logs, or responses;
 *  - the user id derived from that check is the ONLY identity used for
 *    authorization. Client-sent ids (query params, JSON bodies) are untrusted
 *    resource SELECTORS and are re-resolved through src/auth/access every
 *    time — including on every SSE event push;
 *  - all output text goes through the same scrub pipeline as Telegram
 *    (redactSecrets + stored-key redaction);
 *  - on failure the API answers the generic DENY_MESSAGE so a probe can never
 *    distinguish "not found" from "not yours".
 *
 * Live transport: SSE over chunked HTTP. The page consumes it with
 * fetch-streaming (not EventSource) because headers must carry the initData.
 * A `?loopback-ok` bind guard mirrors the old provisioning server: a
 * non-loopback listener is refused unless the public URL is https, so keys
 * and session data never travel over plain HTTP.
 */

const MAX_BODY = 64 * 1024;
const WINDOW_MS = 60_000;
const MAX_READS_PER_WINDOW = 240;
const MAX_WRITES_PER_WINDOW = 60;
const STATUS_EVENTS = new Set<DomainEvent["type"]>([
  "SESSION_CREATED",
  "SESSION_STARTED",
  "SESSION_RECONNECTED",
  "AGENT_WORKING",
  "AGENT_WAITING",
  "APPROVAL_REQUIRED",
  "USER_INPUT_REQUIRED",
  "PROCESS_CRASHED",
  "SESSION_STOPPED",
  "SESSION_FINISHED",
  "CREDENTIAL_INVALID",
]);

interface Window {
  startMs: number;
  reads: number;
  writes: number;
}

export class MiniAppServer {
  private server: http.Server | null = null;
  private rate = new Map<number, Window>();

  constructor(
    private app: App,
    private hub: OutputHub,
    private terminals: TerminalService,
  ) {}

  /** Public base for Mini App buttons; empty when not configured. */
  get publicUrl(): string {
    return this.app.config.webapp.url;
  }

  async listen(): Promise<{ host: string; port: number }> {
    const cfg = this.app.config.webapp;
    if (!cfg.url) throw new Error("webapp.url is not set");
    let httpsUrl = true;
    try {
      httpsUrl = new URL(cfg.url).protocol === "https:";
    } catch {
      httpsUrl = false;
    }
    if (!/^https:\/\//.test(cfg.url))
      throw new Error("webapp.url must be a full https:// URL");
    const loopback = /^(127\.|\[::1\]|localhost$)/.test(cfg.host);
    if (!loopback && !httpsUrl)
      throw new Error("refusing a non-loopback bind without an https:// public URL");
    const server = http.createServer((req, res) => void this.route(req, res).catch(() => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
      } catch {
        /* headers already sent */
      }
      res.end(JSON.stringify({ error: "internal error" }));
    }));
    await new Promise<void>((ok, err) => {
      server.once("error", err);
      server.listen(cfg.port, cfg.host, ok);
    });
    this.server = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : cfg.port;
    this.app.logs.system.info(`mini app api on http://${cfg.host}:${port}`);
    return { host: cfg.host, port };
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    // terminate live SSE streams so no listener/timer outlives shutdown
    s.closeAllConnections?.();
    await new Promise<void>((ok) => s.close(() => ok()));
  }

  // ---------- plumbing ----------

  private scrub(text: string): string {
    return this.app.credentials.redactAll(redactSecrets(text));
  }

  private json(res: http.ServerResponse, code: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((ok, err) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          err(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return ok({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          ok(typeof parsed === "object" && parsed !== null ? parsed : {});
        } catch (e) {
          err(e);
        }
      });
      req.on("error", err);
    });
  }

  /**
   * Authenticate + authorize the ACTOR (never the resource). Returns the
   * server-verified Telegram user id, or null after replying 401/429.
   */
  private actor(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    write: boolean,
  ): number | null {
    const raw = req.headers["x-telegram-init-data"];
    const initData = Array.isArray(raw) ? raw[0] : raw;
    const ident = validateInitData(
      initData ?? undefined,
      this.app.config.telegram.botToken,
      this.app.config.webapp.init_data_max_age_seconds,
    );
    if (!ident || !isAllowedUser(this.app, ident.user.id)) {
      this.json(res, 401, { error: "unauthorized" });
      return null;
    }
    if (!this.allowRate(ident.user.id, write)) {
      this.json(res, 429, { error: "too many requests" });
      return null;
    }
    return ident.user.id;
  }

  private allowRate(uid: number, write: boolean): boolean {
    const now = Date.now();
    let w = this.rate.get(uid);
    if (!w || now - w.startMs > WINDOW_MS) {
      w = { startMs: now, reads: 0, writes: 0 };
      this.rate.set(uid, w);
    }
    if (write) w.writes++;
    else w.reads++;
    return w.reads <= MAX_READS_PER_WINDOW && w.writes <= MAX_WRITES_PER_WINDOW;
  }

  private sessionPayload(uid: number, id: number) {
    const s = resolveSession(this.app, uid, id);
    if (!s) return null;
    const project = s.project_id ? this.app.db.getProject(s.project_id) : undefined;
    return {
      id: s.id,
      name: this.scrub(s.name),
      agent: s.agent_type,
      status: s.status,
      project: project ? this.scrub(project.name) : null,
      cwd: this.scrub(s.cwd),
      host_id: project?.host_id ?? null,
      branch: s.branch,
      waiting_reason: s.waiting_reason,
      created_at: s.created_at,
      updated_at: s.updated_at,
      can_control: true,
    };
  }

  // ---------- routing ----------

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const p = url.pathname;

    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // single-file app: only our inline script/style + Telegram's official SDK
        "content-security-policy":
          "default-src 'self'; script-src 'self' https://telegram.org 'unsafe-inline'; " +
          "style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-src 'self'",
        "x-frame-options": "SAMEORIGIN",
        "referrer-policy": "no-referrer",
      });
      res.end(MINI_APP_HTML);
      return;
    }
    if (req.method === "GET" && p === "/healthz") {
      this.json(res, 200, { ok: true });
      return;
    }
    if (!p.startsWith("/api/")) {
      this.json(res, 404, { error: "not found" });
      return;
    }

    const write = req.method !== "GET";
    const uid = this.actor(req, res, write);
    if (uid === null) return;

    // endpoints that do NOT address a session
    switch (p) {
      case "/api/meta":
        return this.meta(uid, res);
      case "/api/sessions":
        return this.sessions(res, uid);
      case "/api/session/create":
        return this.createSession(uid, req, res);
    }
    const id = this.sessionIdFrom(url, req, res);
    if (id === null) return; // malformed / missing — already answered
    // SERVER-SIDE ownership gate for EVERY session-scoped endpoint. Client
    // ids are selectors, never authorization proof (auth layer re-resolves).
    if (!resolveSession(this.app, uid, id)) {
      this.json(res, 403, { error: DENY_MESSAGE });
      return;
    }

    switch (`${req.method} ${p}`) {
      case "GET /api/session":
        return this.sessionDetail(uid, id, res);
      case "GET /api/session/events":
        return this.stream(uid, id, url, res, "agent");
      case "GET /api/terminal/events":
        return this.stream(uid, id, url, res, "shell");
      case "POST /api/session/input":
        return this.action(uid, res, async () => {
          const body = await this.readBody(req);
          const text = String(body.text ?? "");
          if (!text.trim()) throw new Error("Empty message.");
          await this.app.sessions.sendInput(id, text);
          return { ok: true };
        });
      case "POST /api/session/stop":
        return this.action(uid, res, async () => {
          await this.app.sessions.stop(id);
          return { ok: true };
        });
      case "POST /api/session/resume":
        return this.action(uid, res, async () => {
          const s = await this.app.sessions.resume(id);
          return { ok: true, status: s.status };
        });
      case "POST /api/terminal/start":
        return this.action(uid, res, async () => this.terminals.start(uid, id));
      case "POST /api/terminal/input":
        return this.action(uid, res, async () => {
          const body = await this.readBody(req);
          await this.terminals.sendText(uid, id, String(body.text ?? ""));
          return { ok: true };
        });
      case "POST /api/terminal/key":
        return this.action(uid, res, async () => {
          const body = await this.readBody(req);
          await this.terminals.sendKey(uid, id, String(body.key ?? ""));
          return { ok: true };
        });
      case "POST /api/terminal/stop":
        return this.action(uid, res, async () => {
          this.terminals.stop(uid, id);
          return { ok: true };
        });
      default:
        this.json(res, 404, { error: "not found" });
    }
  }

  private sessionIdFrom(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): number | null {
    const raw = url.searchParams.get("id") ?? "";
    if (!/^\d{1,12}$/.test(raw)) {
      this.json(res, 400, { error: DENY_MESSAGE });
      return null;
    }
    void req;
    return Number(raw);
  }

  /** Uniform error surface: auth denials pass through, everything else generic. */
  private async action(
    uid: number,
    res: http.ServerResponse,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    void uid;
    try {
      const out = await fn();
      this.json(res, 200, out);
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg === DENY_MESSAGE) this.json(res, 403, { error: DENY_MESSAGE });
      else this.json(res, 400, { error: this.scrub(msg).slice(0, 400) });
    }
  }

  private meta(uid: number, res: http.ServerResponse): void {
    const projects = accessibleProjects(this.app, uid).map((pr) => ({
      id: pr.id,
      name: this.scrub(pr.name),
    }));
    this.json(res, 200, {
      agents: this.app.adapters.ids(),
      projects,
      admin: isAdminUser(this.app, uid),
    });
  }

  private sessions(res: http.ServerResponse, uid: number): void {
    const sessions = accessibleSessions(this.app, uid);
    const ACTIVE = ["WORKING", "STARTING", "WAITING_INPUT", "WAITING_APPROVAL"];
    const rows = [...sessions].sort((a, b) => {
      const aa = ACTIVE.includes(a.status) ? 0 : 1;
      const bb = ACTIVE.includes(b.status) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return b.updated_at.localeCompare(a.updated_at) || b.id - a.id;
    });
    this.json(res, 200, {
      sessions: rows.map((s) => {
        const project = s.project_id ? this.app.db.getProject(s.project_id) : undefined;
        return {
          id: s.id,
          name: this.scrub(s.name),
          agent: s.agent_type,
          status: s.status,
          project: project ? this.scrub(project.name) : null,
          updated_at: s.updated_at,
        };
      }),
    });
  }

  private sessionDetail(uid: number, id: number, res: http.ServerResponse): void {
    const meta = this.sessionPayload(uid, id);
    if (!meta) {
      this.json(res, 403, { error: DENY_MESSAGE });
      return;
    }
    const s = resolveSession(this.app, uid, id)!;
    const lines = this.hub.snapshot(id, 50, s.last_output ?? undefined).map((l) => ({
      seq: l.seq,
      at: l.at,
      source: l.source,
      text: this.scrub(l.text),
    }));
    this.json(res, 200, {
      ...meta,
      lines,
      last_seq: lines.length ? lines[lines.length - 1]!.seq : 0,
      terminal: this.terminals.status(id),
    });
  }

  private async createSession(
    uid: number,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    await this.action(uid, res, async () => {
      const body = await this.readBody(req);
      const agent = String(body.agent ?? "");
      const task = String(body.task ?? "").slice(0, 8000);
      const pidRaw = body.project_id;
      const projectId =
        typeof pidRaw === "number" && Number.isSafeInteger(pidRaw) ? pidRaw : null;
      const project =
        projectId !== null ? resolveProject(this.app, uid, projectId) : null;
      if (projectId !== null && !project) throw new Error(DENY_MESSAGE);
      if (!project && !isAdminUser(this.app, uid))
        throw new Error("Pick one of your projects — free-form sessions are admin-only.");
      // Every gate (credential fail-closed, host/project rules, concurrency)
      // runs inside SessionManager.create/start — this is the SAME path the
      // Telegram wizard uses, not a parallel implementation.
      const cwd = project?.root ?? process.cwd();
      const created = await this.app.sessions.create({
        name: `${agent} - ${project?.name ?? "adhoc"}`,
        project_id: project?.id ?? null,
        agent,
        cwd,
        owner_telegram_user_id: uid,
      });
      await this.app.sessions.start(created.id, task || undefined);
      return { id: created.id };
    });
  }

  /**
   * SSE live stream. Ownership was checked at connect; it is RE-CHECKED for
   * every pushed event, so a revoked session stops streaming immediately.
   * Replay uses the hub's `seq` cursor: the client sends `after=<last seq>`
   * and receives exactly the lines it missed — no duplicates, no gaps.
   */
  private stream(
    uid: number,
    id: number,
    url: URL,
    res: http.ServerResponse,
    kind: "agent" | "shell",
  ): void {
    if (!resolveSession(this.app, uid, id)) {
      this.json(res, 403, { error: DENY_MESSAGE });
      return;
    }
    const after = Math.max(0, Number(url.searchParams.get("after") ?? "0") || 0);
    // agent view = agent+system lines; terminal view = shell lines only
    const wants = (source: string): boolean =>
      kind === "shell" ? source === "shell" : source !== "shell";
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let open = true;
    const send = (event: string, data: unknown): void => {
      if (!open) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const end = (): void => {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      unsubLine();
      this.app.bus.off("event", busHandler);
      res.end();
    };

    // replay retained lines of this kind (seq cursor → no duplicates on resume)
    for (const l of this.hub.since(id, after)) {
      if (!wants(l.source)) continue;
      send("line", { seq: l.seq, at: l.at, source: l.source, text: this.scrub(l.text) });
    }
    const ownedNow = (): boolean => resolveSession(this.app, uid, id) !== null;
    const unsubLine = this.hub.subscribe(id, (chunk) => {
      if (!wants(chunk.source)) return;
      if (!ownedNow()) return end(); // ownership revoked mid-stream
      send("line", {
        seq: chunk.seq,
        at: chunk.at,
        source: chunk.source,
        text: this.scrub(chunk.text),
      });
    });

    const busHandler = (e: DomainEvent): void => {
      if (e.session_id !== id || !STATUS_EVENTS.has(e.type)) return;
      if (!ownedNow()) return end();
      const s = this.app.db.getSession(id);
      if (s) send("status", { status: s.status, waiting_reason: s.waiting_reason });
    };
    this.app.bus.on("event", busHandler);

    const heartbeat = setInterval(() => {
      if (open) res.write(": hb\n\n");
    }, 15_000);
    heartbeat.unref?.();

    res.on("close", end);
    res.on("error", end);
  }
}

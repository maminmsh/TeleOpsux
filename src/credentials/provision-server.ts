import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialService } from "./credential-service";
import type { PatValidator, PatVerdict } from "./pat-validator";
import { RateLimiter } from "./rate-limiter";
import {
  CREDENTIAL_API_PATH,
  MINI_APP_CSP,
  MINI_APP_PATH,
  miniAppHtml,
} from "./mini-app-page";
import { validateInitData } from "./telegram-init-data";

const MAX_BODY_BYTES = 16 * 1024;
const PATH_RE = /^\/qoder-key\/([0-9a-f]{48})$/;
const INIT_DATA_HEADER = "x-telegram-init-data";

export interface ProvisionRateLimitConfig {
  window_seconds: number;
  max_auth_attempts_per_ip: number;
  max_submissions_per_user: number;
}

export interface ProvisionConfig {
  enabled: boolean;
  host: string;
  port: number;
  base_url: string;
  /** Trust X-Forwarded-For from a loopback reverse proxy for per-IP limits. */
  trust_proxy?: boolean;
}

export interface ProvisionDeps {
  /** Required to verify Mini App initData. Absent = Mini App routes disabled. */
  botToken?: string;
  /** TeleOps allowlist — the ONLY thing that decides who may store a credential. */
  isAuthorized?: (telegramUserId: number) => boolean;
  /** Optional pre-store check with Qoder; absent means "stored, not verified". */
  validator?: PatValidator;
  /** Full https:// URL Telegram opens (env TELEOPS_MINI_APP_URL). */
  mini_app_url?: string;
  init_data_max_age_seconds?: number;
  rate_limit?: ProvisionRateLimitConfig;
  /** Never receives a credential value — only safe one-line messages. */
  log?: { warn(message: string): void };
}

/** Everything the client may be told. Codes are stable; messages never echo input. */
type ApiError =
  | { code: "bad_request"; message: string }
  | { code: "unauthenticated"; message: string }
  | { code: "forbidden"; message: string }
  | { code: "invalid_pat"; message: string }
  | { code: "rejected"; message: string }
  | { code: "rate_limited"; message: string };

function apiError(e: ApiError): string {
  return JSON.stringify({ ok: false, error: e });
}

/**
 * Credential collection for TeleOps, bound to 127.0.0.1 and fronted (in
 * production) by a TLS-terminating reverse proxy. Two independent front doors,
 * both writing the SAME per-user store:
 *
 *  1. A Telegram Mini App (`GET /qoder-key/app` + `POST /qoder-key/api/credential`)
 *     authenticated by validated initData — the normal path, reachable from
 *     anywhere Telegram is.
 *  2. A single-use, short-lived token link (`/qoder-key/<token>`) for
 *     deployments without a public HTTPS origin (the user tunnels to it over
 *     SSH). The token is random, stored only as a sha256 hash, bound to the
 *     requesting user and spent on first use.
 *
 * A credential never travels in a URL, a command line, a chat message, a log
 * line or a response body, and nothing here logs request bodies at all.
 */
export class ProvisionServer {
  private server: http.Server | null = null;
  private limiter: RateLimiter;
  /**
   * Both the page and the API live under the fixed `/qoder-key/` prefix, so a
   * reverse proxy only has to preserve that prefix (the nginx snippet does).
   */
  private readonly apiPath = CREDENTIAL_API_PATH;

  constructor(
    private creds: CredentialService,
    private cfg: ProvisionConfig,
    private deps: ProvisionDeps = {},
  ) {
    const w = (deps.rate_limit?.window_seconds ?? 900) * 1000;
    this.limiter = new RateLimiter({
      auth: { limit: deps.rate_limit?.max_auth_attempts_per_ip ?? 10, windowMs: w },
      submit: { limit: deps.rate_limit?.max_submissions_per_user ?? 8, windowMs: w },
    });
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** No-op when disabled. Rejects a non-loopback bind unless base_url is https (proxy mode). */
  async start(): Promise<void> {
    if (!this.cfg.enabled || this.server) return;
    const host = this.cfg.host;
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!isLoopback && !this.cfg.base_url.startsWith("https://")) {
      throw new Error(
        "credentials.provision: binding outside 127.0.0.1 requires base_url to be an https:// " +
          "origin (TLS-terminating proxy) — refusing to serve API keys over plain HTTP.",
      );
    }
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.cfg.port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /** The link handed to the user in Telegram (token appears only here). */
  linkFor(token: string): string {
    const base =
      this.cfg.base_url ||
      `http://${this.cfg.host === "0.0.0.0" ? "127.0.0.1" : this.cfg.host}:${this.boundPort}`;
    return `${base.replace(/\/$/, "")}/qoder-key/${token}`;
  }

  /**
   * The Mini App address for the bot's `web_app` button, or null when unset or
   * not https — Telegram refuses plain-HTTP Mini Apps, so anything else is
   * treated as "not configured" rather than handed out as a broken link.
   */
  miniAppUrl(): string | null {
    const raw = this.deps.mini_app_url?.trim() ?? "";
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" || !u.hostname) return null;
      // no query fragments: a Mini App URL that carries secrets is a leak vector
      u.hash = "";
      u.search = "";
      return u.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  /** Human-readable bind address, for the startup log line only. */
  address(): string {
    return `${this.cfg.host}:${this.boundPort}`;
  }

  private get boundPort(): number {
    const addr = this.server?.address();
    return typeof addr === "object" && addr !== null ? (addr as AddressInfo).port : this.cfg.port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0] ?? "/";
    if (path === "/qoder-key/healthz" && req.method === "GET") {
      return this.send(res, 200, JSON.stringify({ ok: true }), {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
    }
    if (path === MINI_APP_PATH) return this.handleMiniAppPage(req, res);
    if (path === this.apiPath || path === CREDENTIAL_API_PATH)
      return this.handleCredentialApi(req, res);
    return this.handleLegacyForm(req, res, path);
  }

  // ---------- Mini App ----------

  private handleMiniAppPage(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD")
      return this.send(res, 405, "", {});
    if (!this.miniAppConfigured())
      return this.send(res, 404, page("Not available", "This deployment has no Mini App configured."));
    this.send(
      res,
      200,
      miniAppHtml(this.apiPath),
      {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": MINI_APP_CSP,
        "X-Content-Type-Options": "nosniff",
      },
    );
  }

  /**
   * The Mini App exists only as a triple: a bot token to verify initData with,
   * an allowlist to check against, and an https origin Telegram will open.
   * Missing any of them disables both the page and the API (fail-closed) — the
   * single-use token link stays available for tunnel-only deployments.
   */
  private miniAppConfigured(): boolean {
    return Boolean(this.deps.botToken && this.deps.isAuthorized && this.miniAppUrl());
  }

  private async handleCredentialApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const json = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    if (req.method !== "POST")
      return this.send(res, 405, apiError({ code: "bad_request", message: "Use POST." }), json);
    if (!this.miniAppConfigured())
      return this.send(res, 404, apiError({ code: "bad_request", message: "Not available." }), json);

    const ip = this.clientIp(req);
    const limited = this.limiter.check("auth", ip);
    if (limited !== null) return this.tooMany(res, limited, json);

    // the raw initData travels in a header, never in the URL and never in a log
    const raw = headerOf(req, INIT_DATA_HEADER);
    const claims = validateInitData(raw, this.deps.botToken ?? "", {
      maxAgeSeconds: this.deps.init_data_max_age_seconds,
    });
    if (!claims.ok) {
      // forging attempts are charged harder than honest page loads
      this.limiter.penalty("auth", ip, 3);
      this.warn(`mini app auth refused (${claims.reason}) from ${ip}`);
      return this.send(
        res,
        401,
        apiError({
          code: "unauthenticated",
          message:
            claims.reason === "expired"
              ? "Your Telegram session for this form expired. Close it and tap the button again."
              : "This form could not be authenticated. Open it from the TeleOps bot button.",
        }),
        json,
      );
    }

    const uid = claims.telegramUserId;
    if (!this.deps.isAuthorized!(uid)) {
      this.warn(`mini app denied for unlisted user ${uid}`);
      return this.send(
        res,
        403,
        apiError({ code: "forbidden", message: "⛔ You do not have access to this resource." }),
        json,
      );
    }

    const userWindow = this.limiter.check("submit", String(uid));
    if (userWindow !== null) return this.tooMany(res, userWindow, json);

    let body: string;
    try {
      body = await readBody(req, "application/json");
    } catch {
      return this.send(
        res,
        415,
        apiError({ code: "bad_request", message: "Expected a small JSON body." }),
        json,
      );
    }
    let pat: string | null = null;
    try {
      const parsed = JSON.parse(body) as { pat?: unknown };
      pat = this.creds.normalizeKey(parsed?.pat);
    } catch {
      pat = null;
    }
    if (pat === null)
      return this.send(
        res,
        400,
        apiError({
          code: "invalid_pat",
          message: "That doesn't look like a usable token (8–512 characters, no line breaks).",
        }),
        json,
      );

    const verdict = await this.probe(pat);
    if (verdict.kind === "rejected")
      return this.send(
        res,
        422,
        apiError({
          code: "rejected",
          message: "Qoder rejected that token. Create a new Personal Access Token and try again.",
        }),
        json,
      );

    try {
      this.creds.save(uid, pat);
    } catch {
      return this.send(
        res,
        400,
        apiError({ code: "invalid_pat", message: "That token could not be stored." }),
        json,
      );
    }
    pat = ""; // drop our only reference as soon as it is encrypted away

    const verified = verdict.kind === "valid";
    return this.send(
      res,
      200,
      JSON.stringify({
        ok: true,
        status: this.creds.status(uid),
        verified,
        message: verified
          ? "✅ Credential saved and confirmed with Qoder. You can close this form."
          : "✅ Credential saved. TeleOps could not verify it with Qoder just now " +
            "(the check was unavailable) — it will be used as-is and reported if a session rejects it.",
      }),
      json,
    );
  }

  /** Never lets a transport problem be mistaken for a refused token. */
  private async probe(pat: string): Promise<PatVerdict> {
    if (!this.deps.validator) return { kind: "unavailable", reason: "disabled" };
    try {
      return await this.deps.validator.check(pat);
    } catch {
      return { kind: "unavailable", reason: "probe_error" };
    }
  }

  private tooMany(
    res: http.ServerResponse,
    retryMs: number,
    headers: Record<string, string>,
  ): void {
    const seconds = Math.max(1, Math.ceil(retryMs / 1000));
    res.writeHead(429, { ...headers, "Retry-After": String(seconds) });
    res.end(
      apiError({
        code: "rate_limited",
        message: `Too many attempts. Wait ${seconds} seconds and try again.`,
      }),
    );
  }

  // ---------- legacy single-use token form ----------

  private async handleLegacyForm(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): Promise<void> {
    const m = path.match(PATH_RE);
    if (!m) return this.send(res, 404, page("Invalid link", "This link is invalid or expired."));

    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    };
    const send = (code: number, html: string) => this.send(res, code, html, headers);

    if (req.method === "GET") return send(200, formHtml());
    if (req.method !== "POST")
      return send(405, page("Invalid link", "This link is invalid or expired."));

    let body = "";
    try {
      body = await readBody(req, "application/x-www-form-urlencoded");
    } catch {
      return send(400, page("Invalid link", "This link is invalid or expired."));
    }
    const token = m[1]!;
    const uid = this.creds.consumeProvisionToken(token);
    if (uid === null) return send(400, page("Invalid link", "This link is invalid or expired."));

    const key = this.creds.normalizeKey(new URLSearchParams(body).get("api_key"));
    if (key === null)
      return send(400, page("Rejected", "That value is not a usable API key. Run /qoderkey for a new link."));
    const verdict = await this.probe(key);
    if (verdict.kind === "rejected")
      return send(400, page("Rejected", "Qoder rejected that token. Run /qoderkey for a new link."));
    try {
      this.creds.save(uid, key);
    } catch {
      // value rejected by shape checks — the token was already spent; the user
      // must request a fresh link. Never echo the submitted value back.
      return send(400, page("Rejected", "That value is not a usable API key. Run /qoderkey for a new link."));
    }
    return send(
      200,
      page(
        "Saved",
        verdict.kind === "valid"
          ? "✅ Credential stored encrypted and confirmed with Qoder. Return to Telegram — you can close this page."
          : "✅ Credential stored encrypted. Return to Telegram — you can close this page.",
      ),
    );
  }

  /**
   * Peer address for rate limiting. X-Forwarded-For is only believed when the
   * packet actually came from a loopback proxy — otherwise it is attacker
   * chatter and would let a client pick its own bucket.
   */
  private clientIp(req: http.IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? "unknown";
    const isLoopback =
      peer === "127.0.0.1" || peer === "::1" || peer.startsWith("::ffff:127.");
    if (!this.cfg.trust_proxy || !isLoopback) return peer;
    const xff = headerOf(req, "x-forwarded-for");
    const first = xff?.split(",")[0]?.trim();
    return first && first.length <= 64 ? first : peer;
  }

  private warn(message: string): void {
    this.deps.log?.warn(message);
  }

  private send(
    res: http.ServerResponse,
    code: number,
    body: string,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(code, headers);
    res.end(body);
  }
}

/** A header that is absent, or repeated, is a refusal — never a guess. */
function headerOf(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" ? v : null;
}

async function readBody(req: http.IncomingMessage, expectType: string): Promise<string> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith(expectType)) throw new Error("bad content type");
  const len = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) throw new Error("body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TeleOps — Qoder credential</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8vh auto;padding:0 16px;color:#222}
input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box;font-family:monospace}
button{padding:10px 18px;background:#2563eb;color:#fff;border:0;border-radius:6px;cursor:pointer}
.hint{color:#666;font-size:13px}</style></head><body>
<h2>Set your Qoder CLI Personal Access Token</h2>
<p>First create or manage the token in your <a href="https://qoder.com/account/integrations" rel="noreferrer">Qoder Account Integrations</a> page.
This page is single-use and expires within minutes. The token is encrypted at rest
and is only ever injected into <b>your own</b> sessions.</p>
<form method="POST" action="">
<input type="password" name="api_key" autocomplete="off" spellcheck="false"
 autocapitalize="none" required placeholder="Qoder Personal Access Token">
<button type="submit">Save credential</button>
</form>
<p class="hint">TeleOps keeps one encrypted Qoder CLI credential for your account. Nothing about the token value is shown or logged afterwards — only its status
(configured / missing / invalid).</p>
</body></html>`;
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>TeleOps — ${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:8vh auto;padding:0 16px">
<h2>${title}</h2><p>${message}</p></body></html>`;
}

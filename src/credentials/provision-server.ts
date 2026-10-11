import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialService } from "./credential-service";

const MAX_BODY_BYTES = 16 * 1024;
const PATH_RE = /^\/qoder-key\/([0-9a-f]{48})$/;

/**
 * Tiny, dependency-free form server that collects a Qoder API key OUTSIDE of
 * Telegram chat (chat messages persist, can be forwarded, deletion is not
 * guaranteed). Links are single-use and short-lived (token is a random 48-hex
 * id stored only as a sha256 hash with an expiry).
 *
 * Transport: binds to 127.0.0.1 by default — localhost is a browser *secure
 * context* and the key never crosses the network (remote users reach it
 * through an SSH tunnel). For remote multi-user deployments put a
 * TLS-terminating reverse proxy in front and set credentials.provision.base_url
 * to that https:// origin; this server then prints https links.
 *
 * Nothing is ever logged: responses carry no-store, the page never echoes the
 * token back, and success/failure pages are identical in shape.
 */
export class ProvisionServer {
  private server: http.Server | null = null;

  constructor(
    private creds: CredentialService,
    private cfg: { enabled: boolean; host: string; port: number; base_url: string },
  ) {}

  get running(): boolean {
    return this.server !== null;
  }

  /** No-op when disabled. Rejects an non-loopback bind unless base_url is https (proxy mode). */
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

  /** Human-readable bind address, for the startup log line only. */
  address(): string {
    return `${this.cfg.host}:${this.boundPort}`;
  }

  private get boundPort(): number {
    const addr = this.server?.address();
    return typeof addr === "object" && addr !== null ? (addr as AddressInfo).port : this.cfg.port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const m = (req.url ?? "").match(PATH_RE);
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
    if (req.method !== "POST") return send(405, page("Invalid link", "This link is invalid or expired."));

    let body = "";
    try {
      body = await readBody(req);
    } catch {
      return send(400, page("Invalid link", "This link is invalid or expired."));
    }
    const token = m[1]!;
    const uid = this.creds.consumeProvisionToken(token);
    if (uid === null) return send(400, page("Invalid link", "This link is invalid or expired."));

    const params = new URLSearchParams(body);
    const key = params.get("api_key") ?? "";
    try {
      this.creds.save(uid, key);
    } catch {
      // value rejected by shape checks — the token was already spent; the user
      // must request a fresh link. Never echo the submitted value back.
      return send(400, page("Rejected", "That value is not a usable API key. Run /qoderkey for a new link."));
    }
    return send(200, page("Saved", "✅ Credential stored encrypted. Return to Telegram — you can close this page."));
  }

  private send(res: http.ServerResponse, code: number, html: string, headers: Record<string, string> = {}): void {
    res.writeHead(code, headers);
    res.end(html);
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) throw new Error("bad content type");
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
<h2>Set your Qoder API key</h2>
<p>This page is single-use and expires within minutes. The key is encrypted at rest
and is only ever injected into <b>your own</b> sessions.</p>
<form method="POST" action="">
<input type="password" name="api_key" autocomplete="off" spellcheck="false"
 autocapitalize="none" required placeholder="Qoder API key">
<button type="submit">Save credential</button>
</form>
<p class="hint">Nothing about the key value is shown or logged afterwards — only its status
(configured / missing / invalid).</p>
</body></html>`;
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>TeleOps — ${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:8vh auto;padding:0 16px">
<h2>${title}</h2><p>${message}</p></body></html>`;
}

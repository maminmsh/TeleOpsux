import { loadConfig } from "../src/config/config";

/**
 * Read-only deployment check for the Qoder credential Mini App.
 * Run it where TeleOps runs, after pointing a reverse proxy at it:
 *
 *   TELEOPS_MINI_APP_URL=https://your-host/qoder-key/app npm run check:miniapp
 *
 * It performs HTTPS/TLS inspection and unauthenticated requests only. No
 * credential is ever sent, printed or written, and nothing here changes nginx,
 * certificates or the running service.
 */
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const raw = config.credentials.mini_app_url;
  if (!raw) {
    console.error(
      "TELEOPS_MINI_APP_URL (or credentials.mini_app_url) is not set — the bot is falling back to single-use links.",
    );
    process.exit(2);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`TELEOPS_MINI_APP_URL is not a valid URL: ${raw}`);
    process.exit(2);
  }

  // 1. Telegram only accepts an https origin for Mini Apps.
  record("https origin", url.protocol === "https:", `configured: ${url.origin}${url.pathname}`);
  if (url.protocol !== "https:") {
    report();
    return;
  }

  // 2. The certificate must be trusted and unexpired — Telegram rejects both.
  const tls = await import("node:tls");
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":");
  await new Promise<void>((resolve) => {
    const port = Number(url.port) || 443;
    const socket = tls.connect(
      {
        host: url.hostname,
        port,
        // RFC 6066 forbids SNI for literal IP addresses.
        servername: isIp ? undefined : url.hostname,
        // This is a diagnostic, not a trust decision: an unverified handshake
        // lets us READ the certificate and report exactly why Telegram would
        // refuse it. `socket.authorized` below is what the check asserts.
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const notAfter = cert?.valid_to ? new Date(cert.valid_to) : null;
        const days = notAfter ? Math.floor((notAfter.getTime() - Date.now()) / 86_400_000) : NaN;
        record(
          "TLS certificate is trusted",
          authorized,
          authorized
            ? `issuer: ${cert.issuer?.O ?? cert.issuer?.CN ?? "?"}`
            : `REJECTED BY TELEGRAM: ${socket.authorizationError} (self-signed or unknown CA)`,
        );
        record(
          "certificate not expiring soon",
          Number.isFinite(days) && days > 14,
          notAfter ? `valid to ${notAfter.toISOString()} (${days} days)` : "no validity dates",
        );
        socket.end();
        resolve();
      },
    );
    socket.setTimeout(8000, () => {
      record("TLS handshake", false, `no response from ${url.hostname}:${port} within 8s`);
      socket.destroy();
      resolve();
    });
    socket.on("error", (e: Error) => {
      record(
        "TLS handshake",
        false,
        `${url.hostname}:${port}: ${e.message} — is a TLS listener answering on that port?`,
      );
      resolve();
    });
  });

  // 3. The backend must be reachable through the proxy at the /qoder-key prefix.
  const health = await getJson(`${url.origin}/qoder-key/healthz`);
  record(
    "credential server proxied",
    health.status === 200 && health.body?.ok === true,
    `GET /qoder-key/healthz → ${health.error ?? health.status}`,
  );

  const page = await getText(url.href);
  if (!page) {
    record("Mini App page served", false, `GET ${url.pathname} could not be fetched (see above)`);
    report();
    return;
  }
  const html = page.body;
  record(
    "Mini App page served",
    page.status === 200 && html.includes("<title>Connect Qoder</title>"),
    `GET ${url.pathname} → ${page.status}, ${html.length} bytes`,
  );
  record(
    "no caching and a strict CSP",
    /no-store/.test(page.headers.get("cache-control") ?? "") &&
      /connect-src 'self'/.test(page.headers.get("content-security-policy") ?? ""),
    `cache-control=${page.headers.get("cache-control")} csp=${page.headers.get("content-security-policy") ?? "MISSING"}`,
  );
  record(
    "no third-party scripts",
    !/src="https?:/.test(html) && !/googletagmanager|analytics/i.test(html),
    "the document loads no external script",
  );

  // 4. An unauthenticated write must be refused — WITHOUT sending any credential.
  const probe = await postEmpty(`${url.origin}/qoder-key/api/credential`);
  record(
    "unauthenticated credential write refused",
    probe.status === 401 || probe.status === 404,
    `POST /qoder-key/api/credential with no initData → ${probe.error ?? probe.status} (expected 401)`,
  );

  report();
}

/** Every network failure is reported, never thrown: a broken deploy is the normal input here. */
async function getJson(href: string): Promise<{ status: number; body?: { ok?: boolean }; error?: string }> {
  try {
    const res = await fetch(href, { method: "GET" });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as { ok?: boolean } };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}

async function getText(
  href: string,
): Promise<{ status: number; body: string; headers: Headers } | null> {
  try {
    const res = await fetch(href, { method: "GET", redirect: "manual" });
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch {
    return null;
  }
}

async function postEmpty(href: string): Promise<{ status: number; error?: string }> {
  try {
    const res = await fetch(href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pat: "check-probe-not-a-real-token" }),
    });
    // The body is never read or printed — only the status matters.
    return { status: res.status };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}

function report(): void {
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}\n   ${r.detail}`);
  }
  console.log(
    failed === 0
      ? "\nAll checks passed — the Mini App is reachable over HTTPS and ready for the Telegram button."
      : `\n${failed} check(s) failed — the Mini App is NOT operational yet; see deploy/teleops-qoder-minapp.nginx.conf.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: Error) => {
  console.error(`check failed: ${e.message}`);
  process.exit(1);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DB } from "../src/db/database";
import { SecretBox } from "../src/shared/secret-box";
import { CredentialService } from "../src/credentials/credential-service";
import { ProvisionServer } from "../src/credentials/provision-server";
import { PatValidator } from "../src/credentials/pat-validator";
import {
  expectedInitDataHash,
  validateInitData,
} from "../src/credentials/telegram-init-data";
import { TelegramController } from "../src/telegram/bot";
import { QoderAdapter } from "../src/adapters/qoder-adapter";
import type { App } from "../src/core/container";
import type { ExecOptions, ExecResult, ExecRunner } from "../src/exec/exec-runner";
import { makeConfig, tempDbFile, tempDir } from "./helpers";

const BOT_TOKEN = "123456:TEST-token-not-a-real-one";
const USER_A = 111;
const USER_B = 222;
const OUTSIDER = 999;
const PAT_A = "qd_pat_AAAAAAAAAAAAAAAAAAAA";
const PAT_B = "qd_pat_BBBBBBBBBBBBBBBBBBBBBB";
const API_URL_PATH = "/qoder-key/api/credential";

/** initData exactly as Telegram builds it: fields + an HMAC over the sorted pairs. */
function buildInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  const map = new Map(Object.entries(fields));
  const hash = expectedInitDataHash(map, botToken);
  map.set("hash", hash);
  return [...map.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function initDataFor(
  telegramUserId: number,
  opts: { authDate?: number; botToken?: string } = {},
): string {
  return buildInitData(
    {
      auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: telegramUserId, first_name: "T", username: `u${telegramUserId}` }),
      query_id: "aqua",
    },
    opts.botToken ?? BOT_TOKEN,
  );
}

/** Records every argv/env the probe child would see, so leaks are visible. */
class FakeProbeRunner implements ExecRunner {
  readonly kind = "local" as const;
  calls: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> = [];
  result: ExecResult = { code: 0, stdout: "model list", stderr: "" };

  async exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, args, env: (opts?.env ?? {}) as Record<string, string | undefined> });
    return this.result;
  }
  async execScript(script: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.exec("sh", ["-c", script], opts);
  }
}

interface Harness {
  creds: CredentialService;
  db: DB;
  server: ProvisionServer;
  warns: string[];
  probe: FakeProbeRunner;
  base: string;
  dir: string;
  url: (p: string) => string;
  stop: () => void;
}

async function harness(
  opts: {
    allowed?: number[];
    limits?: { window_seconds: number; max_auth_attempts_per_ip: number; max_submissions_per_user: number };
    validator?: boolean;
    miniAppUrl?: string | null;
    botToken?: string;
  } = {},
): Promise<Harness> {
  const dir = tempDir("teleops-miniapp-");
  const db = new DB(tempDbFile(dir));
  const creds = new CredentialService(db, new SecretBox(path.join(dir, "teleops.key")));
  const config = makeConfig({
    allowed_users: opts.allowed ?? [USER_A, USER_B],
    admin_users: [USER_A],
  });
  const probe = new FakeProbeRunner();
  const validator = new PatValidator(
    { command: "qoder", enabled: true, timeoutSeconds: 5 },
    probe,
  );
  const warns: string[] = [];
  const server = new ProvisionServer(
    creds,
    { enabled: true, host: "127.0.0.1", port: 0, base_url: "", trust_proxy: false },
    {
      botToken: opts.botToken ?? BOT_TOKEN,
      isAuthorized: (uid) => config.security.allowed_users.includes(uid),
      validator: opts.validator === false ? undefined : validator,
      mini_app_url: opts.miniAppUrl === undefined ? "https://teleops.example.com/qoder-key/app" : opts.miniAppUrl,
      init_data_max_age_seconds: 3600,
      rate_limit: opts.limits ?? {
        window_seconds: 900,
        max_auth_attempts_per_ip: 10,
        max_submissions_per_user: 8,
      },
      log: { warn: (m) => warns.push(m) },
    },
  );
  await server.start();
  const base = `http://127.0.0.1:${server.address().split(":")[1]}`;
  return {
    creds,
    db,
    server,
    warns,
    probe,
    base,
    dir,
    url: (p: string) => base + p,
    stop: () => {
      server.stop();
      db.close();
    },
  };
}

/** What a real Mini App sends: initData in a header, PAT in the JSON body. */
function postCredential(url: string, initData: string | null, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(initData === null ? {} : { "X-Telegram-Init-Data": initData }),
    },
    body: JSON.stringify(body),
  });
}

describe("initData validation (pure)", () => {
  it("accepts a correctly signed payload and yields ONLY the user id from it", () => {
    const r = validateInitData(initDataFor(USER_B), BOT_TOKEN);
    assert.ok(r.ok);
    assert.equal(r.telegramUserId, USER_B);
    assert.equal(r.username, `u${USER_B}`);
  });

  it("rejects a forged signature, a tampered user field and another bot's token", () => {
    const good = initDataFor(USER_A);
    assert.equal(validateInitData(good.replace(/hash=[0-9a-f]+/, `hash=${"0".repeat(64)}`), BOT_TOKEN).ok, false);
    const tampered = good.replace(encodeURIComponent(JSON.stringify({ id: USER_A, first_name: "T", username: "u111" })), encodeURIComponent(JSON.stringify({ id: USER_B, first_name: "T", username: "u222" })));
    assert.deepEqual(
      validateInitData(tampered, BOT_TOKEN),
      { ok: false, reason: "bad_signature" },
    );
    assert.equal(validateInitData(good, "999999:other-bot-token").ok, false);
  });

  it("rejects missing, malformed, hashless, userless and out-of-window auth_date", () => {
    assert.equal(validateInitData("", BOT_TOKEN).reason, "missing");
    assert.equal(validateInitData(null, BOT_TOKEN).reason, "missing");
    assert.equal(validateInitData("nonsense", BOT_TOKEN).reason, "malformed");
    assert.equal(validateInitData("user=%7B%22id%22%3A1%7D", BOT_TOKEN).reason, "no_hash");
    const noUser = buildInitData({ auth_date: String(Math.floor(Date.now() / 1000)) }, BOT_TOKEN);
    assert.equal(validateInitData(noUser, BOT_TOKEN).reason, "no_user");
    assert.equal(
      validateInitData(initDataFor(USER_A, { authDate: Math.floor(Date.now() / 1000) - 7200 }), BOT_TOKEN, {
        maxAgeSeconds: 3600,
      }).reason,
      "expired",
    );
    assert.equal(
      validateInitData(initDataFor(USER_A, { authDate: Math.floor(Date.now() / 1000) + 3600 }), BOT_TOKEN)
        .reason,
      "from_the_future",
    );
  });

  it("the hash is bound to every field, so an extra or renamed field breaks it", () => {
    const base = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: USER_A }),
    };
    const signed = buildInitData(base, BOT_TOKEN);
    assert.equal(validateInitData(signed, BOT_TOKEN).ok, true);
    assert.equal(validateInitData(`${signed}&chat_type=group`, BOT_TOKEN).ok, false);
  });
});

describe("Mini App credential API: authentication and authorization", () => {
  it("serves the form page with a no-store, script-free CSP", async () => {
    const h = await harness();
    try {
      const res = await fetch(h.url("/qoder-key/app"));
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store, max-age=0");
      assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
      assert.ok(!/src="https?:\/\//.test(html), "no external scripts");
      assert.ok(!/localStorage|sessionStorage|document\.cookie|console\./.test(html));
      assert.match(html, /<title>Connect Qoder<\/title>/);
      assert.ok(html.includes(API_URL_PATH), "posts to the JSON endpoint");
    } finally {
      h.stop();
    }
  });

  it("stores the credential for a valid initData submission", async () => {
    const h = await harness();
    try {
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.deepEqual({ ok: body.ok, status: body.status, verified: body.verified }, {
        ok: true, status: "configured", verified: true,
      });
      assert.ok(!JSON.stringify(body).includes(PAT_A));
      assert.equal(h.creds.status(USER_A), "configured");
      assert.equal(h.creds.revealForLaunch(USER_A), PAT_A);
    } finally {
      h.stop();
    }
  });

  it("refuses an invalid signature, an expired session and missing auth data — nothing is stored", async () => {
    const h = await harness({
      limits: { window_seconds: 900, max_auth_attempts_per_ip: 100, max_submissions_per_user: 100 },
    });
    try {
      const forged = initDataFor(USER_A).replace(/hash=[0-9a-f]{64}/, `hash=${"a".repeat(64)}`);
      for (const init of [
        forged,
        initDataFor(USER_A, { authDate: Math.floor(Date.now() / 1000) - 99_999 }),
        null,
        "garbage",
        initDataFor(USER_A, { botToken: "111:other-token" }),
      ]) {
        const res = await postCredential(h.url(API_URL_PATH), init, { pat: PAT_A });
        assert.equal(res.status, 401, `expected refusal for ${String(init).slice(0, 20)}`);
        const body = await res.json();
        assert.equal(body.error.code, "unauthenticated");
        assert.ok(!JSON.stringify(body).includes(PAT_A));
      }
      assert.equal(h.creds.status(USER_A), "missing");
      assert.equal(h.db.listCredentialStatuses().length, 0);
      assert.ok(h.warns.every((w) => !w.includes(PAT_A)), "auth refusals never log the value");
    } finally {
      h.stop();
    }
  });

  it("a valid signature from a user outside the allowlist is denied with the standard message", async () => {
    const h = await harness();
    try {
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(OUTSIDER), { pat: PAT_A });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error.message, "⛔ You do not have access to this resource.");
      assert.equal(h.creds.status(OUTSIDER), "missing");
    } finally {
      h.stop();
    }
  });

  it("a client cannot switch users by editing the request: the body carries no user id", async () => {
    const h = await harness();
    try {
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), {
        pat: PAT_A,
        telegram_user_id: USER_B,
        user_id: USER_B,
        uid: USER_B,
      });
      assert.equal(res.status, 200);
      assert.equal(h.creds.revealForLaunch(USER_A), PAT_A);
      assert.equal(h.creds.status(USER_B), "missing", "the claimed id in the body is ignored");
    } finally {
      h.stop();
    }
  });

  it("rejects missing, empty, oversized and control-character tokens", async () => {
    const h = await harness();
    try {
      for (const pat of [undefined, null, "", "short", "a".repeat(513), "line1\nline2xx", "tab\tinside_x"]) {
        const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, "invalid_pat");
      }
      assert.equal(h.creds.status(USER_A), "missing");
      // a non-JSON body is refused before anything is read
      const bad = await fetch(h.url(API_URL_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Telegram-Init-Data": initDataFor(USER_A) },
        body: `pat=${PAT_A}`,
      });
      assert.equal(bad.status, 415);
      assert.equal(h.creds.status(USER_A), "missing");
      assert.equal((await fetch(h.url(API_URL_PATH), { method: "GET" })).status, 405);
    } finally {
      h.stop();
    }
  });
});

describe("per-user isolation, replacement and revocation", () => {
  it("user A's submission never reads, writes or overwrites user B's credential", async () => {
    const h = await harness();
    try {
      h.creds.save(USER_B, PAT_B);
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      assert.equal(res.status, 200);
      assert.equal(h.creds.revealForLaunch(USER_A), PAT_A);
      assert.equal(h.creds.revealForLaunch(USER_B), PAT_B, "B's key is untouched");
      const rows = new Map(h.db.listCredentialKeyBlobs().map((r) => [r.telegram_user_id, r.key_enc]));
      assert.equal(rows.size, 2);
      assert.notEqual(rows.get(USER_A), rows.get(USER_B));
    } finally {
      h.stop();
    }
  });

  it("concurrent submissions from different users cannot cross-write", async () => {
    const h = await harness();
    try {
      const posts = [USER_A, USER_B, USER_A, USER_B, USER_A, USER_B].map((uid, i) =>
        postCredential(h.url(API_URL_PATH), initDataFor(uid), {
          pat: uid === USER_A ? `PAT_A_${i}_aaaaaaaaaaaa` : `PAT_B_${i}_bbbbbbbbbbbb`,
        }),
      );
      const res = await Promise.all(posts);
      assert.ok(res.every((r) => r.status === 200), "every authenticated user is served");
      const a = h.creds.revealForLaunch(USER_A);
      const b = h.creds.revealForLaunch(USER_B);
      assert.match(a!, /^PAT_A_\d+_a+$/);
      assert.match(b!, /^PAT_B_\d+_b+$/);
    } finally {
      h.stop();
    }
  });

  it("replacement and revocation are per user; encrypted at rest with a fresh IV each time", async () => {
    const h = await harness();
    try {
      const first = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      assert.equal(first.status, 200);
      const blob1 = h.db.listCredentialKeyBlobs()[0]!.key_enc;

      const replaced = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), {
        pat: PAT_A.replace(/A+$/, "ZZZZZZZZZZ"),
      });
      assert.equal(replaced.status, 200, "a user may replace their own credential");
      const second = PAT_A.replace(/A+$/, "ZZZZZZZZZZ");
      assert.equal(h.creds.revealForLaunch(USER_A), second);
      assert.notEqual(h.db.listCredentialKeyBlobs()[0]!.key_enc, blob1, "IV is random");

      const box = new SecretBox(path.join(h.dir, "teleops.key"));
      const rows = h.db.listCredentialKeyBlobs();
      assert.equal(box.decrypt(rows[0]!.key_enc), second);
      assert.throws(() => box.decrypt(rows[0]!.key_enc.replace(/^.{8}/, "00000000")));

      h.creds.remove(USER_A);
      assert.equal(h.creds.status(USER_A), "missing");
      assert.equal(h.creds.revealForLaunch(USER_A), null);
      assert.equal(h.creds.hasCredential(USER_A), false, "Qoder sessions stay blocked");
    } finally {
      h.stop();
    }
  });

  it("the plaintext token appears in no response, log line, argv or file on disk", async () => {
    const h = await harness();
    try {
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      const text = await res.text();
      assert.ok(!text.includes(PAT_A));

      // the probe child sees the token ONLY in its environment
      assert.equal(h.probe.calls.length, 1);
      const call = h.probe.calls[0]!;
      assert.ok(!JSON.stringify(call.args).includes(PAT_A), "never an argument");
      assert.equal(call.env.QODER_PERSONAL_ACCESS_TOKEN, PAT_A);
      assert.equal(call.env.QODER_API_KEY, undefined, "legacy server-wide var is cleared");

      assert.ok(!h.warns.join("\n").includes(PAT_A));
      const onDisk = [...fs.readdirSync(h.dir, { recursive: true, encoding: "utf8" })]
        .map((f) => {
          try {
            return fs.readFileSync(path.join(h.dir, f)).toString("latin1");
          } catch {
            return "";
          }
        })
        .join("");
      assert.ok(onDisk.length > 1000, "the database file was actually read");
      assert.ok(!onDisk.includes(PAT_A), "database file holds ciphertext only");
      assert.equal(h.db.listCredentialStatuses()[0]!.status, "configured");
    } finally {
      h.stop();
    }
  });
});

describe("rate limiting", () => {
  it("failed authentications from one address are charged and then locked out", async () => {
    const h = await harness({ limits: { window_seconds: 900, max_auth_attempts_per_ip: 3, max_submissions_per_user: 50 } });
    try {
      const forged = initDataFor(USER_A).replace(/hash=[0-9a-f]{64}/, `hash=${"b".repeat(64)}`);
      const r1 = await postCredential(h.url(API_URL_PATH), forged, { pat: PAT_A });
      assert.equal(r1.status, 401);
      const r2 = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      assert.equal(r2.status, 429, "one forgery attempt already trips the window");
      assert.match(r2.headers.get("retry-after") ?? "", /^\d+$/);
      assert.equal((await r2.json()).error.code, "rate_limited");
      assert.equal(h.creds.status(USER_A), "missing", "a limited client stores nothing");
    } finally {
      h.stop();
    }
  });

  it("accepted submissions per user are capped", async () => {
    const h = await harness({ limits: { window_seconds: 900, max_auth_attempts_per_ip: 100, max_submissions_per_user: 2 } });
    try {
      for (let i = 0; i < 2; i++) {
        const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: `${PAT_A}${i}` });
        assert.equal(res.status, 200);
      }
      const third = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: `${PAT_A}9` });
      assert.equal(third.status, 429);
      assert.equal(h.creds.revealForLaunch(USER_A), `${PAT_A}1`, "the limited write never happened");
    } finally {
      h.stop();
    }
  });

  it("without a proxy the peer address is used, so X-Forwarded-For cannot pick a fresh bucket", async () => {
    const h = await harness({ limits: { window_seconds: 900, max_auth_attempts_per_ip: 2, max_submissions_per_user: 50 } });
    try {
      const forged = initDataFor(USER_A).replace(/hash=[0-9a-f]{64}/, `hash=${"c".repeat(64)}`);
      await postCredential(h.url(API_URL_PATH), forged, { pat: PAT_A });
      const res = await fetch(h.url(API_URL_PATH), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Init-Data": initDataFor(USER_A),
          "X-Forwarded-For": "203.0.113.99",
        },
        body: JSON.stringify({ pat: PAT_A }),
      });
      assert.equal(res.status, 429, "spoofed header did not buy a new window");
    } finally {
      h.stop();
    }
  });
});

describe("Qoder token validation before anything is stored", () => {
  it("a token Qoder rejects is refused and never persisted", async () => {
    const h = await harness();
    try {
      h.probe.result = {
        code: 1,
        stdout: "",
        stderr:
          "Failed to fetch model list: The QODER_PERSONAL_ACCESS_TOKEN environment variable contains a token that was rejected.",
      };
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      assert.equal(res.status, 422);
      assert.equal((await res.json()).error.code, "rejected");
      assert.equal(h.creds.status(USER_A), "missing");
      assert.equal(h.probe.calls[0]!.cmd, "qoder");
      assert.deepEqual(h.probe.calls[0]!.args.slice(0, 2), ["--list-models", "--config-dir"]);
      assert.ok(!h.probe.calls[0]!.args.join(" ").includes(PAT_A));
    } finally {
      h.stop();
    }
  });

  it("an unavailable check is reported honestly instead of a fake confirmation", async () => {
    const h = await harness();
    try {
      h.probe.result = { code: null, stdout: "", stderr: "spawn qoder ENOENT" };
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.verified, false);
      assert.match(body.message, /could not verify/i);
      assert.equal(h.creds.status(USER_A), "configured");

      // a timeout must not be mistaken for a rejected token
      h.probe.result = { code: 124, stdout: "", stderr: "timed out", timedOut: true };
      const again = await postCredential(h.url(API_URL_PATH), initDataFor(USER_B), { pat: PAT_B });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).verified, false);
    } finally {
      h.stop();
    }
  });

  it("works without a validator at all (stored, unverified) and never blocks saving", async () => {
    const h = await harness({ validator: false });
    try {
      const res = await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).verified, false);
      assert.equal(h.probe.calls.length, 0);
    } finally {
      h.stop();
    }
  });

  it("the probe runs in a private config dir that is removed afterwards", async () => {
    const runner = new FakeProbeRunner();
    const v = new PatValidator({ command: "qoder", enabled: true, timeoutSeconds: 5 }, runner);
    const verdict = await v.check(PAT_A);
    assert.deepEqual(verdict, { kind: "valid" });
    const dir = runner.calls[0]!.args[2]!;
    assert.match(dir, /teleops-pat-probe-/);
    assert.equal(fs.existsSync(dir), false, "probe scratch dir is cleaned up");
    assert.equal(runner.calls[0]!.env.HOME, dir, "no other login can be consulted");

    runner.result = { code: 1, stdout: "Not logged in. Run `qodercli login` to authenticate.", stderr: "" };
    assert.deepEqual(await v.check(PAT_A), { kind: "unavailable", reason: "token_not_read" });
    runner.result = { code: 1, stdout: "", stderr: "some network error" };
    assert.equal((await v.check(PAT_A)).kind, "unavailable");

    const off = new PatValidator({ command: "qoder", enabled: false, timeoutSeconds: 5 }, runner);
    assert.equal((await off.check(PAT_A)).kind, "unavailable");
    assert.equal(runner.calls.length, 3, "a disabled validator never spawns the CLI");
  });
});

describe("deployment surface: Mini App URL, fallback link, existing flows", () => {
  function urlsFor(mini_app_url: string | undefined): string | null {
    const s = new ProvisionServer(
      null as never,
      { enabled: true, host: "127.0.0.1", port: 8717, base_url: "" },
      { mini_app_url },
    );
    return s.miniAppUrl();
  }

  it("only a valid https:// URL enables the button, and query/fragment data is dropped", () => {
    assert.equal(urlsFor("https://app.example.com/qoder-key/app"), "https://app.example.com/qoder-key/app");
    assert.equal(urlsFor("https://app.example.com/qoder-key/app?token=secret#frag"), "https://app.example.com/qoder-key/app");
    assert.equal(urlsFor("http://app.example.com/qoder-key/app"), null, "Telegram requires HTTPS");
    assert.equal(urlsFor("not a url"), null);
    assert.equal(urlsFor(""), null);
    assert.equal(urlsFor(undefined), null);
  });

  it("the single-use token link still provisions the same store when there is no HTTPS origin", async () => {
    const h = await harness({ miniAppUrl: null });
    try {
      const token = h.creds.createProvisionToken(USER_A);
      const link = h.server.linkFor(token);
      assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/qoder-key\/[0-9a-f]{48}$/);
      const page = await (await fetch(link)).text();
      assert.ok(page.includes('type="password"'));
      const saved = await fetch(link, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `api_key=${encodeURIComponent(PAT_A)}`,
      });
      assert.equal(saved.status, 200);
      assert.match(await saved.text(), /stored encrypted/);
      assert.equal(h.creds.status(USER_A), "configured");
      assert.equal(h.creds.hasCredential(USER_A), true, "SessionManager's gate is now satisfied");

      // the app page and API are simply absent without a configured origin
      assert.equal((await fetch(h.url("/qoder-key/app"))).status, 404);
      assert.equal((await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_B })).status, 404);
    } finally {
      h.stop();
    }
  });

  it("a token link cannot be replayed and a spent one stores nothing further", async () => {
    const h = await harness({ miniAppUrl: null });
    try {
      const token = h.creds.createProvisionToken(USER_A);
      const link = h.server.linkFor(token);
      await fetch(link, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `api_key=${encodeURIComponent(PAT_A)}`,
      });
      const replay = await fetch(link, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `api_key=${encodeURIComponent(PAT_B)}`,
      });
      assert.equal(replay.status, 400);
      assert.equal(h.creds.revealForLaunch(USER_A), PAT_A);
    } finally {
      h.stop();
    }
  });

  it("refuses to bind a public interface without an https base_url (plain HTTP keys are never served)", async () => {
    const exposed = new ProvisionServer(
      null as never,
      { enabled: true, host: "0.0.0.0", port: 8799, base_url: "" },
      {},
    );
    await assert.rejects(exposed.start(), /https/);
  });

  it("healthz answers without disclosing anything", async () => {
    const h = await harness();
    try {
      const res = await fetch(h.url("/qoder-key/healthz"));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      h.stop();
    }
  });

  it("/qoderkey shows a web_app button when HTTPS is configured and a link otherwise", async () => {
    const withApp = await harness();
    const withoutApp = await harness({ miniAppUrl: "http://insecure.example.com/qoder-key/app" });
    try {
      for (const [h, expectButton] of [
        [withApp, true],
        [withoutApp, false],
      ] as Array<[Harness, boolean]>) {
        const controller = new TelegramController(botApp(h));
        const ctx = keyCtx(USER_A);
        await (controller as unknown as { qoderKeyCommand(c: unknown): Promise<void> }).qoderKeyCommand(ctx);
        const keyboard = (
          ctx.markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }
        ).inline_keyboard;
        const flat = keyboard.flat();
        // grammy emits the web_app payload without a `type` field — Telegram infers it
        const webApp = flat.find((b) => b.web_app !== undefined);
        assert.equal(Boolean(webApp), expectButton);
        if (expectButton) {
          assert.equal(webApp!.text, "🔐 Open Secure Qoder Setup");
          assert.deepEqual(webApp!.web_app, { url: "https://teleops.example.com/qoder-key/app" });
          assert.ok(!ctx.replies.join("\n").includes("http://127.0.0.1"), "no tunnel link when the app works");
        } else {
          assert.match(ctx.replies.join("\n"), /\/qoder-key\/[0-9a-f]{48}/, "falls back to a single-use link");
        }
        // the token value is never part of any reply or button
        assert.ok(!ctx.replies.join(" ").includes(PAT_A));
        assert.ok(!JSON.stringify(ctx.markup).includes(PAT_A));
      }
    } finally {
      withApp.stop();
      withoutApp.stop();
    }
  });

  it("Qoder sessions keep launching exactly as before with the stored credential", async () => {
    const h = await harness();
    try {
      await postCredential(h.url(API_URL_PATH), initDataFor(USER_A), { pat: PAT_A });
      const adapter = new QoderAdapter("qoder");
      assert.equal(adapter.credentialEnvVar, "QODER_PERSONAL_ACCESS_TOKEN");
      const launch = adapter.launchCommand({
        cwd: "/srv/a",
        secretFilePath: "$HOME/.teleops-credentials/teleops-session-7.key",
      });
      assert.match(launch, /unset QODER_PERSONAL_ACCESS_TOKEN QODER_API_KEY/);
      assert.match(launch, /\$\(cat "\$HOME\/\.teleops-credentials\/teleops-session-7\.key"\)/);
      assert.ok(!launch.includes(PAT_A), "the value never enters the pane command");
      assert.throws(
        () => adapter.launchCommand({ cwd: "/srv/a", secretFilePath: "/etc/passwd" }),
        /not a TeleOps-generated path/,
      );
      assert.equal(adapter.detectCredentialError("invalid api key"), true);
    } finally {
      h.stop();
    }
  });
});

function botApp(h: Harness): App {
  const config = makeConfig({ allowed_users: [USER_A, USER_B], admin_users: [USER_A] });
  return { config, credentials: h.creds, provision: h.server } as unknown as App;
}

function keyCtx(userId: number): {
  from: { id: number };
  chat: { id: number };
  replies: string[];
  markup: unknown;
  reply: (text: string, opts?: { reply_markup?: unknown }) => Promise<{ message_id: number }>;
} {
  const ctx = {
    from: { id: userId },
    chat: { id: 1000 + userId },
    replies: [] as string[],
    markup: null as unknown,
    reply: async (text: string, opts?: { reply_markup?: unknown }) => {
      ctx.replies.push(text);
      ctx.markup = opts?.reply_markup ?? null;
      return { message_id: 1 };
    },
  };
  return ctx;
}


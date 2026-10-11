import crypto from "node:crypto";

/**
 * Telegram Mini App (`initData`) validation, per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * The client is untrusted: a user id taken from `initDataUnsafe`, a request
 * field or a cookie proves nothing. Identity comes ONLY from data whose HMAC
 * we can verify with our own bot token, which also binds the payload to this
 * bot (another bot's initData cannot forge a valid hash here).
 */

/** Anything older than this is refused; `auth_date` further ahead than the skew is refused too. */
export const DEFAULT_MAX_AUTH_AGE_SECONDS = 3600;
export const MAX_CLOCK_SKEW_SECONDS = 60;

export type InitDataFailure =
  | "missing"
  | "malformed"
  | "no_hash"
  | "no_user"
  | "bad_signature"
  | "expired"
  | "from_the_future";

export type InitDataResult =
  | { ok: true; telegramUserId: number; authDate: number; username: string | null }
  | { ok: false; reason: InitDataFailure };

export interface InitDataOptions {
  /** Reject `auth_date` older than this (seconds). */
  maxAgeSeconds?: number;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * The `data_check_string`: every received field except `hash`, URL-decoded,
 * `key=value` pairs sorted by key and joined with "\n".
 */
export function dataCheckString(params: Map<string, string>): string {
  return [...params.entries()]
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Server-side secret derived from the bot token — never leaves this process. */
export function initDataSecretKey(botToken: string): Buffer {
  const authKey = crypto.createHash("sha256").update(botToken, "utf8").digest();
  return crypto.createHmac("sha256", authKey).update("WebAppData").digest();
}

/** Expected hash for a set of decoded initData fields (also used to build test fixtures). */
export function expectedInitDataHash(params: Map<string, string>, botToken: string): string {
  return crypto
    .createHmac("sha256", initDataSecretKey(botToken))
    .update(dataCheckString(params), "utf8")
    .digest("hex");
}

/** Parse the raw percent-encoded query string into decoded fields, preserving duplicates as failures. */
function parseFields(initData: string): Map<string, string> | null {
  if (!initData || initData.length > 16 * 1024) return null;
  const out = new Map<string, string>();
  for (const pair of initData.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    try {
      const decodedKey = decodeURIComponent(key.replace(/\+/g, " "));
      const decodedValue = decodeURIComponent(value.replace(/\+/g, " "));
      if (out.has(decodedKey)) return null;
      out.set(decodedKey, decodedValue);
    } catch {
      return null; // malformed percent-encoding
    }
  }
  return out.size ? out : null;
}

/**
 * Verify a raw `Telegram.WebApp.initData` string. Returns the authenticated
 * user id only when the signature, the freshness window and the payload shape
 * all check out — every other path is a refusal.
 */
export function validateInitData(
  initData: string | undefined | null,
  botToken: string,
  opts: InitDataOptions = {},
): InitDataResult {
  if (!initData || !botToken) return { ok: false, reason: "missing" };
  const fields = parseFields(initData);
  if (!fields) return { ok: false, reason: "malformed" };

  const hash = fields.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "no_hash" };

  // recompute over the same fields and compare without leaking timing
  const expected = expectedInitDataHash(fields, botToken);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(hash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return { ok: false, reason: "bad_signature" };

  const authDate = Number(fields.get("auth_date") ?? "");
  if (!Number.isInteger(authDate) || authDate <= 0)
    return { ok: false, reason: "malformed" };

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AUTH_AGE_SECONDS;
  if (authDate < now - maxAge) return { ok: false, reason: "expired" };
  if (authDate > now + MAX_CLOCK_SKEW_SECONDS)
    return { ok: false, reason: "from_the_future" };

  let telegramUserId: number | null = null;
  let username: string | null = null;
  try {
    const user = JSON.parse(fields.get("user") ?? "") as {
      id?: unknown;
      username?: unknown;
    };
    if (typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0)
      telegramUserId = user.id;
    if (typeof user.username === "string") username = user.username;
  } catch {
    telegramUserId = null;
  }
  if (telegramUserId === null) return { ok: false, reason: "no_user" };

  return { ok: true, telegramUserId, authDate, username };
}

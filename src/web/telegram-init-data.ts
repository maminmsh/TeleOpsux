import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Telegram Mini App `initData` validation (docs §"auth"). The client-side
 * `initDataUnsafe.user.id` is NOT an identity proof — every API call must
 * carry the raw `initData` string here, and only the HMAC check against the
 * bot token establishes the real Telegram user id. The raw initData is never
 * logged, never placed in URLs, and never echoed in errors.
 */

export interface WebAppUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface WebAppIdentity {
  user: WebAppUser;
}

function parsePairs(initData: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of initData.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = decodeURIComponent(part.slice(eq + 1));
    out.set(key, value);
  }
  return out;
}

/**
 * Returns the authenticated identity, or null when the initData is forged,
 * stale, malformed, or belongs to a user we cannot trust. On success the
 * caller must STILL apply the normal allowed-user / ownership rules.
 */
export function validateInitData(
  initData: string | undefined,
  botToken: string,
  maxAgeSeconds: number,
): WebAppIdentity | null {
  if (!initData || !botToken) return null;
  const params = parsePairs(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date") ?? "0");
  if (!hash || !Number.isFinite(authDate) || authDate <= 0) return null;
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > maxAgeSeconds || age < -60) return null;

  const checkPairs: string[] = [];
  for (const [k, v] of params) {
    if (k === "hash") continue;
    checkPairs.push(`${k}=${v}`);
  }
  checkPairs.sort();
  const dataCheckString = checkPairs.join("\n");

  const secretKey = createHmac("sha256", botToken).update("WebAppData").digest();
  const digest = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (digest.length !== hash.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(digest), Buffer.from(hash))) return null;
  } catch {
    return null;
  }

  const userJson = params.get("user");
  if (!userJson) return null;
  let user: unknown;
  try {
    user = JSON.parse(userJson);
  } catch {
    return null;
  }
  if (
    typeof user !== "object" ||
    user === null ||
    !Number.isSafeInteger((user as WebAppUser).id) ||
    (user as WebAppUser).id <= 0
  )
    return null;
  return { user: user as WebAppUser };
}

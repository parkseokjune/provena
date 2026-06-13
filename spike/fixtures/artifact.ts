import { createHmac, timingSafeEqual } from "crypto";

export function buildAccessToken(payload: object): string {
  const header = { alg: "HS256", typ: "JWT" };
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  return sign({ ...payload, exp }, header);
}

export function refreshTokenExpiry(): Date {
  const now = new Date();
  now.setDate(now.getDate() + 30);
  return now;
}

export function storeRefreshToken(db: Db, raw: string, userId: string) {
  const hashed = createHmac("sha256", PEPPER).update(raw).digest("hex");
  db.refreshTokens.insert({ userId, hashed });
}

export function verifyStripeSignature(body: string, header: string): boolean {
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(body).digest();
  const provided = Buffer.from(header, "hex");
  return timingSafeEqual(expected, provided);
}

export function redeemAuthCode(db: Db, code: string): boolean {
  if (db.usedCodes.has(code)) return false;
  db.usedCodes.add(code);
  return true;
}

export function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

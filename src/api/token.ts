import { fernetEncrypt, fernetDecrypt } from "../crypto/fernet.ts";
import { hashPhone } from "../crypto/hash.ts";
import { setUserApiToken } from "../db/queries.ts";
import type { Db } from "../db/client.ts";
import type { Env } from "../types.ts";
import type { User } from "../db/schema.ts";

export function generateApiToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `tdo_${b64}`;
}

export async function hashApiToken(token: string): Promise<string> {
  return hashPhone(token);
}

export async function issueOrRotateToken(db: Db, env: Env, userId: number): Promise<string> {
  const token = generateApiToken();
  const [encrypted, hash] = await Promise.all([
    fernetEncrypt(token, env.ENCRYPTION_KEY),
    hashApiToken(token),
  ]);
  await setUserApiToken(db, userId, encrypted, hash);
  return token;
}

export async function getActiveToken(db: Db, env: Env, user: User): Promise<string | null> {
  if (!user.api_token_encrypted) return null;
  try {
    return await fernetDecrypt(user.api_token_encrypted, env.ENCRYPTION_KEY);
  } catch {
    return null;
  }
}

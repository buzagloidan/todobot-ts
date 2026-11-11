import type { Env } from "../types.ts";

export async function signControl(
  env: Env,
  kind: string,
  ...values: (number | string)[]
): Promise<string> {
  const payload = ["td", kind, ...values].join(":");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return `${payload}:${Array.from(signature)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}
export async function verifyControl(
  env: Env,
  value: string,
  actorId: number,
): Promise<{ kind: string; values: string[] } | null> {
  if (
    value.length > 250 ||
    !/^td:[a-z]+:[a-zA-Z0-9:-]+:[a-f0-9]{64}$/.test(value)
  )
    return null;
  const parts = value.split(":");
  const signature = parts.pop()!;
  if (parts[2] !== String(actorId)) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.match(/../g)!, (n) =>
    parseInt(n, 16),
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      new TextEncoder().encode(parts.join(":")),
    ))
  )
    return null;
  return { kind: parts[1], values: parts.slice(2) };
}

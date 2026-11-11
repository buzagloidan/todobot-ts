/** Per-service API rate limiters using Cloudflare KV counters. */

export type Service = "gemini" | "whatsapp";

const SERVICE_LIMITS: Record<Service, { perMinute: number; perHour: number; perDay: number }> = {
  gemini:    { perMinute: 60,    perHour: 1_000,  perDay: 10_000 },
  whatsapp:  { perMinute: 900,   perHour: 50_000, perDay: 1_000_000 },
};

export async function checkServiceRateLimit(
  kv: KVNamespace,
  service: Service
): Promise<{ allowed: boolean; message?: string }> {
  const now = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  const ymd = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const m = `${ymd}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  const h = `${ymd}${p(now.getUTCHours())}`;
  const d = ymd;

  const limits = SERVICE_LIMITS[service];

  const [mRaw, hRaw, dRaw] = await Promise.all([
    kv.get(`svc:${service}:m:${m}`),
    kv.get(`svc:${service}:h:${h}`),
    kv.get(`svc:${service}:d:${d}`),
  ]);

  const mCount = (mRaw ? parseInt(mRaw, 10) : 0) + 1;
  const hCount = (hRaw ? parseInt(hRaw, 10) : 0) + 1;
  const dCount = (dRaw ? parseInt(dRaw, 10) : 0) + 1;

  if (mCount > limits.perMinute) return { allowed: false, message: `${service} per-minute rate limit exceeded` };
  if (hCount > limits.perHour)   return { allowed: false, message: `${service} per-hour rate limit exceeded` };
  if (dCount > limits.perDay)    return { allowed: false, message: `${service} per-day rate limit exceeded` };

  // Update counters (non-atomic but acceptable for soft rate limiting)
  await Promise.all([
    kv.put(`svc:${service}:m:${m}`, String(mCount), { expirationTtl: 120 }),
    kv.put(`svc:${service}:h:${h}`, String(hCount), { expirationTtl: 7_200 }),
    kv.put(`svc:${service}:d:${d}`, String(dCount), { expirationTtl: 172_800 }),
  ]);

  return { allowed: true };
}

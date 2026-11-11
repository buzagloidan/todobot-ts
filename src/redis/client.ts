/**
 * KV-backed cache, rate limiting, and distributed locks.
 * Uses Cloudflare KV (wa-bot-cache namespace) instead of Upstash Redis.
 * KV TTL is in seconds via expirationTtl.
 */

// ── QueryCache ─────────────────────────────────────────────────────────────────

export class QueryCache {
  constructor(private kv: KVNamespace, private defaultTtl = 300) {}

  async getOrSet<T>(key: string, fn: () => Promise<T>, ttl?: number): Promise<T> {
    try {
      const cached = await this.kv.get(key, "json");
      if (cached !== null) return cached as T;
    } catch {
      // fall through on KV error
    }
    const result = await fn();
    try {
      await this.kv.put(key, JSON.stringify(result), { expirationTtl: ttl ?? this.defaultTtl });
    } catch {
      // non-fatal
    }
    return result;
  }

  async invalidate(key: string): Promise<void> {
    try { await this.kv.delete(key); } catch { /* ignore */ }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    // KV supports prefix listing
    const prefix = pattern.replace(/\*.*$/, "");
    try {
      let cursor: string | undefined;
      do {
        const list = await this.kv.list({ prefix, cursor });
        await Promise.all(list.keys.map((k) => this.kv.delete(k.name)));
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
    } catch { /* ignore */ }
  }
}

// ── Distributed lock — KV SET NX EX equivalent ────────────────────────────────

export async function acquireLock(kv: KVNamespace, key: string, ttlSeconds = 60): Promise<boolean> {
  const lockKey = `lock:${key}`;
  // KV has no atomic compare-and-set, but cron triggers run single-instance so
  // this read-then-write is safe enough to prevent duplicate reminder sends.
  const existing = await kv.get(lockKey);
  if (existing !== null) return false;
  await kv.put(lockKey, "1", { expirationTtl: ttlSeconds });
  return true;
}

export async function releaseLock(kv: KVNamespace, key: string): Promise<void> {
  try { await kv.delete(`lock:${key}`); } catch { /* ignore */ }
}

// ── Per-user sliding-window rate limit (counter per minute bucket) ────────────

export async function checkUserRateLimit(
  kv: KVNamespace,
  userId: number,
  windowMs = 60_000,
  maxMessages = 20
): Promise<{ allowed: boolean; message?: string }> {
  const bucket = Math.floor(Date.now() / windowMs);
  const key = `rl:user:${userId}:${bucket}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= maxMessages) {
    return { allowed: false, message: "אתה שולח הרבה הודעות 😅 המתן רגע ונסה שוב" };
  }
  await kv.put(key, String(count + 1), { expirationTtl: Math.ceil((windowMs * 2) / 1000) });
  return { allowed: true };
}

// ── Daily message limit ────────────────────────────────────────────────────────

export async function checkDailyMessageLimit(
  kv: KVNamespace,
  userId: number,
  maxDaily = 100
): Promise<{ allowed: boolean; message?: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `daily:${userId}:${today}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= maxDaily) {
    return { allowed: false, message: `הגעת למכסת ההודעות להיום 😊 נסה שוב מחר` };
  }
  await kv.put(key, String(count + 1), { expirationTtl: 86_400 * 2 });
  return { allowed: true };
}

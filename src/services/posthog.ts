/**
 * PostHog analytics — fire-and-forget HTTP capture API.
 * Uses the PostHog server-side capture endpoint directly (no SDK needed).
 */
import type { Env } from "../types.ts";

const POSTHOG_HOST = "https://eu.i.posthog.com";
const POSTHOG_TIMEOUT_MS = 2500;
const POSTHOG_RETRIES = 2;

export interface EventProperties {
  [key: string]: string | number | boolean | null | undefined;
}

export interface AnalyticsWaitUntil {
  (promise: Promise<unknown>): void;
}

export interface PostHogOptions {
  waitUntil?: AnalyticsWaitUntil;
  timeoutMs?: number;
  retries?: number;
}

async function posthogRequest(
  env: Env,
  payload: Record<string, unknown>,
  options: PostHogOptions = {}
): Promise<void> {
  if (!env.POSTHOG_API_KEY) return;

  const timeoutMs = options.timeoutMs ?? POSTHOG_TIMEOUT_MS;
  const retries = options.retries ?? POSTHOG_RETRIES;
  const url = `${POSTHOG_HOST}/capture/`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`PostHog API ${res.status}: ${body}`);
      }

      return;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 75 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

/**
 * Capture a single analytics event. Fire-and-forget — never throws.
 */
export async function capture(
  env: Env,
  distinctId: string,
  event: string,
  properties: EventProperties = {},
  options: PostHogOptions = {}
): Promise<void> {
  const promise = posthogRequest(env, {
    api_key: env.POSTHOG_API_KEY,
    event,
    distinct_id: distinctId,
    properties: {
      $lib: "cloudflare-workers",
      ...properties,
    },
    timestamp: new Date().toISOString(),
  }, options).catch(() => {
    // Never let analytics failures affect the main flow
  });

  if (options.waitUntil) {
    options.waitUntil(promise);
    return;
  }

  await promise;
}

/**
 * Identify a user with traits. Call on new user creation.
 */
export async function identify(
  env: Env,
  distinctId: string,
  traits: EventProperties = {},
  options: PostHogOptions = {}
): Promise<void> {
  const promise = posthogRequest(env, {
    api_key: env.POSTHOG_API_KEY,
    event: "$identify",
    distinct_id: distinctId,
    properties: {
      $lib: "cloudflare-workers",
      $set: traits,
      $set_once: traits,
    },
    timestamp: new Date().toISOString(),
  }, options).catch(() => {
    // Never let analytics failures affect the main flow
  });

  if (options.waitUntil) {
    options.waitUntil(promise);
    return;
  }

  await promise;
}

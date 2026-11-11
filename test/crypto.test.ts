/// <reference types="@cloudflare/vitest-plugin" />
import { describe, it, expect } from "vitest";
import { fernetEncrypt, fernetDecrypt } from "../src/crypto/fernet.ts";
import { hashPhone } from "../src/crypto/hash.ts";
import { TEST_ENC_KEY } from "./helpers.ts";

describe("fernetEncrypt / fernetDecrypt", () => {
  it("round-trips ASCII plaintext correctly", async () => {
    const plaintext = "Buy milk from the store";
    const ciphertext = await fernetEncrypt(plaintext, TEST_ENC_KEY);
    expect(await fernetDecrypt(ciphertext, TEST_ENC_KEY)).toBe(plaintext);
  });

  it("round-trips Hebrew text correctly", async () => {
    const plaintext = "לקנות חלב מהמכולת";
    const ciphertext = await fernetEncrypt(plaintext, TEST_ENC_KEY);
    expect(await fernetDecrypt(ciphertext, TEST_ENC_KEY)).toBe(plaintext);
  });

  it("produces different ciphertext on each call (random IV)", async () => {
    const plaintext = "Buy milk";
    const ct1 = await fernetEncrypt(plaintext, TEST_ENC_KEY);
    const ct2 = await fernetEncrypt(plaintext, TEST_ENC_KEY);
    expect(ct1).not.toBe(ct2);
    expect(await fernetDecrypt(ct1, TEST_ENC_KEY)).toBe(plaintext);
    expect(await fernetDecrypt(ct2, TEST_ENC_KEY)).toBe(plaintext);
  });

  it("throws on an invalid / plaintext token", async () => {
    await expect(
      fernetDecrypt("not_a_valid_fernet_token", TEST_ENC_KEY)
    ).rejects.toThrow();
  });
});

describe("hashPhone", () => {
  it("is deterministic for the same input", async () => {
    const h1 = await hashPhone("972501234567");
    const h2 = await hashPhone("972501234567");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different numbers", async () => {
    expect(await hashPhone("972501234567")).not.toBe(
      await hashPhone("972509876543")
    );
  });

  it("returns a 64-char hex string (SHA-256)", async () => {
    const h = await hashPhone("972501234567");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

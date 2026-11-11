/** SHA-256 of a phone number (E.164 string), hex-encoded — mirrors bot.py hash_for_search */
export async function hashPhone(phone: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(phone));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

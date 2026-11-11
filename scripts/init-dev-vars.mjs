import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const target = new URL('../.dev.vars', import.meta.url);
const fernetKey = randomBytes(32).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
const secrets = {
  ENCRYPTION_KEY: Buffer.from(fernetKey).toString('base64url'),
  APP_SECRET: randomBytes(32).toString('hex'),
  VERIFY_TOKEN: randomBytes(32).toString('base64url'),
};
let content = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
for (const [name, value] of Object.entries(secrets)) content = content.replace(`${name}=""`, `${name}="${value}"`);
try { writeFileSync(target, content, { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code === 'EEXIST') throw new Error('.dev.vars already exists; preserve its encryption key.'); throw error; }
console.log('Created private .dev.vars. Add your Meta and Gemini credentials before a live conversation.');

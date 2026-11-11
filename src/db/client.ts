import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";
import type { Env } from "../types.ts";

export type Db = ReturnType<typeof buildDb>;

export function buildDb(env: Env) {
  return drizzle(env.DB, { schema });
}

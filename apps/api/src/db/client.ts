import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const databases = new WeakMap<D1Database, ReturnType<typeof createClient>>();
function createClient(binding: D1Database) {
    return drizzle(binding, { schema });
}

export function createDatabase(binding: D1Database) {
    let db = databases.get(binding);
    if (!db) {
        db = createClient(binding);
        databases.set(binding, db);
    }
    return db;
}

export type Database = ReturnType<typeof createDatabase>;

import "dotenv/config";
import { loadConfig } from "../config/config";
import { DB } from "./database";

const config = loadConfig();
const db = new DB(config.paths.database_file);

const version = db.schemaVersion();
const tables = db
  .raw()
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as Array<{ name: string }>;

console.log(`schema migrated to user_version=${version}`);
console.log(`tables: ${tables.map((t) => t.name).join(", ")}`);
db.close();

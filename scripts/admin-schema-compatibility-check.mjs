import { readFileSync } from "node:fs";

const checkedFiles = ["lib/server/admin-dashboard.ts", "lib/server/search-events.ts"];
const failures = checkedFiles.filter((file) => readFileSync(file, "utf8").includes("actor_id"));

if (failures.length) {
  console.error(`Production schema compatibility check failed: actor_id referenced in ${failures.join(", ")}`);
  process.exit(1);
}

console.log("Admin/search-event schema compatibility check passed.");

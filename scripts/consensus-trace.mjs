import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { inspect } from "node:util";

const root = process.cwd();
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(root, request.slice(2)), parent, isMain, options);
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

if (fs.existsSync(".env.local")) {
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (!process.env[key]) {
      process.env[key] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  process.stderr.write("Usage: node scripts/consensus-trace.mjs \"Best pizza on Long Island\"\n");
  process.exit(1);
}

const jiti = (await import("jiti")).default(root + "/");
const { POST } = jiti("./app/api/search/route.ts");
const { collectConsensusTraceDuring } = jiti("./lib/server/consensus-engine.ts");

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const capturedLogs = [];

function captureLog(level) {
  return (...args) => {
    capturedLogs.push({
      level,
      label: typeof args[0] === "string" ? args[0] : null,
      args: args.map((arg) => (typeof arg === "string" ? arg : JSON.parse(JSON.stringify(arg))))
    });
  };
}

console.log = captureLog("log");
console.warn = captureLog("warn");
console.error = captureLog("error");

let result;
let trace;

try {
  ({ result, trace } = await collectConsensusTraceDuring(async () => {
    const request = new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query })
    });
    const response = await POST(request);
    return {
      status: response.status,
      body: await response.json()
    };
  }));
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

if (!trace) {
  process.stdout.write(`No trace was collected for query: ${query}\n`);
  process.exit(1);
}

const output = [];
output.push(`Consensus trace: ${query}`);
output.push(`HTTP status: ${result.status}`);
output.push(`Classification: ${trace.classification?.mode ?? result.body?.mode ?? "unknown"}`);
output.push(`Results: ${(trace.classification?.resultNames ?? result.body?.results?.map((item) => item.name) ?? []).join(" | ") || "(none)"}`);
output.push("");
output.push("Task");
output.push(`  normalized: ${trace.task.normalizedQuery}`);
output.push(`  canonical: ${trace.task.canonicalQuery}`);
output.push(`  evidenceType: ${trace.task.evidenceType}`);
output.push(`  intent: ${trace.task.queryIntent}`);
output.push("");
output.push("Cache");
output.push(`  status: ${trace.cache.status}`);
output.push(`  version: ${trace.cache.cacheVersion ?? "unknown"}`);
output.push(`  hitType: ${trace.cache.cacheHitType ?? "n/a"}`);
output.push(`  elapsedMs: ${trace.cache.elapsedMs ?? trace.latency.cacheMs ?? "n/a"}`);
output.push("");
output.push("Stages");
for (const stage of trace.stages) {
  output.push(`  ${stage.stage}: ${stage.status} (${stage.durationMs ?? 0}ms)`);
  if (stage.output !== undefined) {
    output.push(`    ${inspect(stage.output, { depth: 4, colors: false, compact: true })}`);
  }
}
output.push("");
output.push("Sources");
output.push(`  retrievedCount: ${trace.retrievedSourceCount ?? "unknown"}`);
output.push(`  retained: ${trace.retainedSources.length}`);
for (const source of trace.retainedSources.slice(0, 10)) {
  output.push(`    - ${source.domain}: ${source.title} (${source.url})`);
}
output.push(`  discarded: ${trace.discardedSources.length}`);
for (const item of trace.sourceDiagnostics.filter((diagnostic) => !diagnostic.retained).slice(0, 12)) {
  output.push(`    discarded - ${item.reasonCode ?? "unknown"}: ${item.domain ?? item.source?.domain ?? "unknown"} ${item.url ?? item.source?.url ?? ""}`);
  if (item.queryVariant) output.push(`      lane: ${item.queryVariant}`);
  if (item.message) output.push(`      ${item.message}`);
}
output.push("");
output.push("Entities");
output.push(`  candidates: ${trace.candidateEntities.length}`);
output.push(`  accepted: ${trace.acceptedEntities.length}`);
output.push(`  rejected: ${trace.rejectedEntities.length}`);
output.push(`  downgraded: ${trace.downgradedEntities.length}`);
output.push(`  resolved: ${trace.entityResolutionDiagnostics.length}`);
for (const resolution of trace.entityResolutionDiagnostics.slice(0, 16)) {
  output.push(
    `    ${resolution.action} - ${resolution.originalName} -> ${resolution.canonicalName} (${resolution.relationshipType}, ${resolution.reasonCode}, requested=${resolution.requestedEntityType}, transferred=${resolution.evidenceTransferred})`
  );
}
for (const outcome of trace.entityValidationDiagnostics.slice(0, 12)) {
  output.push(`    ${outcome.validator} - ${outcome.status}: ${outcome.originalName} -> ${outcome.canonicalName ?? "n/a"} (${outcome.reasonCode})`);
}
for (const entity of trace.rejectedEntities.slice(0, 12)) {
  output.push(`    rejected - ${entity.name}: ${entity.discardReason?.code ?? "unknown"} (${entity.discardReason?.message ?? "no message"})`);
}
output.push("");
output.push("Aggregation");
output.push(`  entrants: ${trace.aggregationEntrants.length}`);
for (const contender of trace.contenderScores.slice(0, 10)) {
  output.push(
    `    - ${contender.name}: net=${contender.netWeightedScore ?? "n/a"}, localFinal=${contender.localFinalScore ?? "n/a"}, sources=${contender.sourceCount ?? "n/a"}`
  );
}
output.push("");
output.push("Classification");
output.push(`  mode: ${trace.classification?.mode ?? "unknown"}`);
output.push(`  source: ${trace.classification?.source ?? "unknown"}`);
output.push(`  rationale: ${trace.classification?.rationale ?? "unavailable"}`);
if (trace.classification?.decisionPath) {
  output.push(`  classifier: ${trace.classification.decisionPath.classifier}`);
  output.push(`  selectedPath: ${trace.classification.decisionPath.selectedPath}`);
  output.push(`  finalReasonCode: ${trace.classification.decisionPath.finalReasonCode}`);
  output.push(`  margins: ${inspect(trace.classification.decisionPath.leaderMargin ?? {}, { depth: 2, colors: false, compact: true })}`);
}
output.push("");
output.push("Final Cleanup");
for (const cleanup of trace.cleanupDiagnostics.slice(0, 20)) {
  output.push(`  - ${cleanup.stage}: ${cleanup.reasonCode} (${cleanup.contenderName}) ${cleanup.message ?? ""}`.trimEnd());
}
if (!trace.cleanupDiagnostics.length) output.push("  (none exposed)");
output.push("");
output.push("Calls and Latency");
output.push(`  calls: ${inspect(trace.callCounts ?? {}, { depth: 3, colors: false, compact: true })}`);
output.push(`  latency: ${inspect(trace.latency, { depth: 2, colors: false, compact: true })}`);
output.push("");
output.push("Discard Reasons");
for (const discard of trace.discards.slice(0, 20)) {
  output.push(`  - ${discard.stage}: ${discard.code} ${discard.contenderName ? `(${discard.contenderName})` : ""} ${discard.message ?? ""}`.trimEnd());
}
if (!trace.discards.length) output.push("  (none exposed)");
output.push("");
output.push("Unavailable Trace Gaps");
for (const gap of trace.unavailable) {
  output.push(`  - ${gap}`);
}
output.push("");
output.push(`Captured internal log lines: ${capturedLogs.length}`);

process.stdout.write(`${output.join("\n")}\n`);

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

for (const line of fs.readFileSync(".env.local", "utf8").split(/\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (!match) continue;
  const key = match[1].trim();
  if (!process.env[key]) {
    process.env[key] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

const jiti = (await import("jiti")).default(root + "/");
const { searchPublicWeb, recoverLocalSparseSources } = jiti("./lib/server/search.ts");
const { analyzeConsensusWithDebug, buildLocalFallbackConsensus } = jiti("./lib/server/analyze.ts");
const { inferQueryEvidenceType } = jiti("./lib/utils.ts");

const queries = process.argv.slice(2);
if (!queries.length) {
  queries.push(
    "Best nursing home on Long Island",
    "Best hair salon in Hempstead",
    "Best pizza on Long Island",
    "Best sushi in Brooklyn",
    "Best dentist in Boca Raton",
    "Best coffee shop in Portland",
    "Best cocktail bar in Manhattan"
  );
}

const keepLabels = new Set([
  "LOCAL_PLACE_EXTRACTOR_ACCEPTED",
  "LOCAL_PLACE_EXTRACTOR_REJECTED",
  "LOCAL_PLACE_EXTRACTOR_REJECTION_REASON",
  "LOCAL_CANDIDATE_REJECTED_REASON",
  "LOCAL_RAW_EXTRACTED_CANDIDATES",
  "LOCAL_FINAL_VALID_CANDIDATES",
  "LOCAL_BUSINESSES_FOUND",
  "LOCAL_FINAL_VERIFIED_CONTENDERS",
  "LOCAL_FINAL_RANKS",
  "LOCAL_FINAL_CUISINE_CONTENDERS",
  "PLACES_VALIDATION_RESULT",
  "PLACES_REJECTED",
  "PLACES_UNATTEMPTED_SIGNAL_REJECTED",
  "FINAL_CONTENDERS",
  "FILTERED_CONTENDERS",
  "QUERY_EVIDENCE_TYPE",
  "[vera:sources] source pipeline",
  "[vera:consensus] classification decision path"
]);

function normalizeLogArg(value) {
  if (typeof value === "string") return value;
  return JSON.parse(JSON.stringify(value));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function runQuery(query) {
  const captured = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  const capture = (...args) => {
    const label = args[0];
    if (typeof label === "string" && keepLabels.has(label)) {
      captured.push({ label, args: args.slice(1).map(normalizeLogArg) });
    }
  };

  console.log = capture;
  console.warn = capture;

  try {
    const evidenceType = inferQueryEvidenceType(query);
    let sources = await searchPublicWeb(query);
    let analysis = await analyzeConsensusWithDebug(query, sources);
    let routeConsensus = analysis.consensus;
    const routeStages = [{ stage: "initial_analysis", mode: routeConsensus.mode, results: routeConsensus.results.map((result) => result.name) }];

    if (evidenceType === "local_recommendation" && routeConsensus.results.length < 3) {
      routeConsensus = (await buildLocalFallbackConsensus(query, sources, "fallback diagnostic")) ?? routeConsensus;
      routeStages.push({ stage: "local_fallback", mode: routeConsensus.mode, results: routeConsensus.results.map((result) => result.name) });
    }

    if (evidenceType === "local_recommendation" && routeConsensus.results.length < 3) {
      const recoveredSources = await recoverLocalSparseSources(query, sources);
      routeStages.push({ stage: "sparse_recovery_sources", sourceCount: recoveredSources.length });
      if (recoveredSources.length > sources.length) {
        sources = recoveredSources;
        analysis = await analyzeConsensusWithDebug(query, sources);
        const recoveredConsensus = analysis.consensus;
        if (validLocalResultCount(recoveredConsensus) >= validLocalResultCount(routeConsensus)) {
          routeConsensus = recoveredConsensus;
        }
        routeStages.push({
          stage: "sparse_recovery_analysis",
          mode: recoveredConsensus.mode,
          results: recoveredConsensus.results.map((result) => result.name),
          keptResults: routeConsensus.results.map((result) => result.name)
        });
      }
    }

    const extractionCandidates = captured
      .filter((entry) => entry.label === "LOCAL_PLACE_EXTRACTOR_ACCEPTED" || entry.label === "LOCAL_PLACE_EXTRACTOR_REJECTED")
      .map((entry) => ({
        name: entry.args[0]?.candidate ?? entry.args[0]?.name,
        source: entry.args[0]?.source ?? entry.args[0]?.sourceUrl,
        accepted: entry.label === "LOCAL_PLACE_EXTRACTOR_ACCEPTED",
        reason: entry.args[0]?.reason ?? null,
        confidence: entry.args[0]?.confidence ?? null,
        extractionSource: entry.args[0]?.extractionSource ?? null
      }));
    const placesResults = captured
      .filter((entry) => entry.label === "PLACES_VALIDATION_RESULT")
      .map((entry) => entry.args[0])
      .map((item) => ({
        candidate: item.candidate,
        status: item.status,
        canonicalName: item.canonicalName,
        rejectionReason: item.rejectionReason,
        verifiedAddress: item.verifiedAddress,
        types: item.types,
        categoryConfidence: item.categoryConfidence,
        locationConfidence: item.locationConfidence,
        overallConfidence: item.overallConfidence
      }));
    const rawAggregate = captured.filter((entry) => entry.label === "LOCAL_RAW_EXTRACTED_CANDIDATES").at(-1)?.args[0] ?? [];
    const finalValid = captured.filter((entry) => entry.label === "LOCAL_FINAL_VALID_CANDIDATES").at(-1)?.args[0] ?? [];
    const finalContenders = captured.filter((entry) => entry.label === "FINAL_CONTENDERS").at(-1)?.args[0] ?? [];
    const finalDecision = captured.filter((entry) => entry.label === "[vera:consensus] classification decision path").at(-1)?.args[0] ?? null;

    return {
      query,
      evidenceType,
      tavilyResults: sources.map((source) => ({
        title: source.title,
        url: source.url,
        domain: source.domain,
        queryVariant: source.queryVariant
      })),
      contendersExtracted: uniqueBy(extractionCandidates, (item) => `${item.name}|${item.source}|${item.accepted}`).slice(0, 80),
      placesValidation: uniqueBy(placesResults, (item) => `${item.candidate}|${item.status}|${item.rejectionReason ?? ""}`),
      validationSurvivors: uniqueBy(
        placesResults.filter((item) => item.status === "verified"),
        (item) => item.canonicalName ?? item.candidate
      ).map((item) => item.canonicalName ?? item.candidate),
      enteringAggregation: rawAggregate,
      survivingFinalCleanup: finalValid,
      finalContenders,
      finalClassification: {
        directMode: analysis.consensus.mode,
        routeMode: routeConsensus.mode,
        routeResults: routeConsensus.results.map((result) => ({ rank: result.rank, name: result.name })),
        decision: finalDecision,
        routeStages
      }
    };
  } catch (error) {
    return {
      query,
      error: error instanceof Error ? error.stack ?? error.message : inspect(error)
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function validLocalResultCount(consensus) {
  return consensus.results.filter((result) => result.name && (result.consensusPercentage ?? 0) > 0).length;
}

const results = [];
for (const query of queries) {
  process.stderr.write(`Running ${query}\n`);
  results.push(await runQuery(query));
}

const outputPath = process.env.LOCAL_DIAG_OUTPUT;
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  process.stderr.write(`Wrote ${outputPath}\n`);
} else {
  console.log(JSON.stringify(results, null, 2));
}

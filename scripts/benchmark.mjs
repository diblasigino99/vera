import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const benchmarkFile = path.join(rootDir, "benchmarks", "consensus-benchmarks.json");
const resultsDir = path.join(rootDir, "benchmarks", "results");
const defaultPort = Number(process.env.BENCHMARK_PORT ?? 3117);
const requestTimeoutMs = Number(process.env.BENCHMARK_REQUEST_TIMEOUT_MS ?? 150000);

const aliases = new Map(
  Object.entries({
    google: ["google search", "google.com"],
    "google chrome": ["chrome"],
    "google maps": ["maps"],
    "microsoft edge": ["edge"],
    "duckduckgo": ["duck duck go"],
    "proton mail": ["protonmail"],
    "microsoft excel": ["excel"],
    "google sheets": ["sheets"],
    "google calendar": ["calendar"],
    "outlook calendar": ["microsoft outlook calendar", "outlook"],
    "github copilot": ["copilot"],
    "claude code": ["anthropic claude code"],
    "zoho crm": ["zoho"],
    "monday.com": ["monday"],
    "quickbooks": ["quickbooks online"],
    "eero pro 6e": ["amazon eero pro 6e", "eero"],
    "netgear orbi": ["orbi"],
    "tp-link deco": ["deco"],
    "brooks ghost": ["brooks ghost 16", "brooks ghost 17"],
    "nike pegasus": ["nike air zoom pegasus", "pegasus"],
    "asics gel-nimbus": ["gel nimbus", "asics gel nimbus"],
    "hoka clifton": ["clifton"],
    "away carry-on": ["away the carry-on", "away"],
    "travelpro platinum elite": ["travelpro"],
    "monos carry-on": ["monos"],
    "sony wh-1000xm5": ["sony xm5", "wh-1000xm5"],
    "bose quietcomfort ultra": ["bose qc ultra", "quietcomfort ultra"],
    "apple airpods max": ["airpods max"],
    "breville bambino plus": ["bambino plus"],
    "breville barista express": ["barista express"],
    "delonghi dedica": ["de'longhi dedica", "de longhi dedica"],
    "acer aspire": ["acer aspire 5"],
    "lenovo ideapad": ["ideapad"],
    "asus vivobook": ["vivobook"],
    "keychron q1": ["q1"],
    "keychron k2": ["k2"],
    "logitech mx mechanical": ["mx mechanical"],
    "herman miller aeron": ["aeron"],
    "steelcase gesture": ["gesture"],
    "herman miller embody": ["embody"],
    "coway airmega ap-1512hh": ["coway ap-1512hh", "coway mighty"],
    "blueair blue pure": ["blue pure", "blueair"],
    "levoit core": ["levoit"],
    "four seasons hotel seattle": ["four seasons seattle"],
    "the moore hotel": ["moore hotel"],
    "belltown inn": ["the belltown inn"],
    "sushi nakazawa": ["nakazawa"],
    "serendipity3": ["serendipity 3"],
    "ellens stardust diner": ["ellen's stardust diner"],
    "bethpage black": ["bethpage black course", "bethpage state park black"],
    "all american hamburger drive-in": ["all american", "all american hamburger"],
    "tsujita la artisan noodle": ["tsujita", "tsujita annex"],
    "veracruz all natural": ["veracruz"],
    "the violet hour": ["violet hour"]
  })
);

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    limit: Number(process.env.BENCHMARK_LIMIT ?? 0),
    category: process.env.BENCHMARK_CATEGORY ?? "",
    baseUrl: process.env.BENCHMARK_BASE_URL ?? "",
    noServer: process.env.BENCHMARK_NO_SERVER === "1"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") parsed.limit = Number(args[index + 1] ?? 0);
    if (arg === "--category") parsed.category = args[index + 1] ?? "";
    if (arg === "--base-url") parsed.baseUrl = args[index + 1] ?? "";
    if (arg === "--no-server") parsed.noServer = true;
  }

  return parsed;
}

async function main() {
  const options = parseArgs();
  const benchmarks = JSON.parse(await readFile(benchmarkFile, "utf8"));
  const selected = benchmarks
    .filter((benchmark) => !options.category || benchmark.category === options.category)
    .slice(0, options.limit > 0 ? options.limit : benchmarks.length);

  if (selected.length === 0) {
    throw new Error("No benchmarks selected.");
  }

  const server = await prepareServer(options);
  const startedAt = new Date();

  try {
    const cases = [];

    for (const [index, benchmark] of selected.entries()) {
      const label = `[${index + 1}/${selected.length}] ${benchmark.query}`;
      process.stdout.write(`${label}\n`);

      const result = await runBenchmark(server.baseUrl, benchmark);
      cases.push(result);

      const top = result.actualResults.slice(0, 3).join(", ") || "no results";
      process.stdout.write(`  winner: ${result.actualWinner || "none"} | top 3: ${top}\n`);
    }

    const report = buildReport({
      benchmarks: selected,
      cases,
      timestamp: startedAt.toISOString(),
      commitHash: getCommitHash(),
      baseUrl: server.baseUrl
    });

  printReport(report);
  logProductBenchmarkSummary(report);
  logLocalBenchmarkSummary(report);
  await saveReport(report);
  } finally {
    await server.stop();
  }
}

async function prepareServer(options) {
  if (options.baseUrl) {
    return {
      baseUrl: stripTrailingSlash(options.baseUrl),
      stop: async () => {}
    };
  }

  if (options.noServer) {
    return {
      baseUrl: `http://127.0.0.1:${defaultPort}`,
      stop: async () => {}
    };
  }

  const baseUrl = `http://127.0.0.1:${defaultPort}`;
  const child = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(defaultPort)], {
    cwd: rootDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverOutput = "";
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`Benchmark server did not start. ${error.message}\n${serverOutput.slice(-2000)}`);
  }

  return {
    baseUrl,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 1500);
      });
    }
  };
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 30000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
      if (response.ok || response.status < 500) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(500);
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for server.");
}

async function runBenchmark(baseUrl, benchmark) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: benchmark.query }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const elapsedMs = Date.now() - startedAt;
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    return scoreCase(benchmark, {
      error: payload.error ?? `HTTP ${response.status}`,
      elapsedMs,
      result: null
    });
  }

  return scoreCase(benchmark, {
    error: null,
    elapsedMs,
    result: payload
  });
}

function scoreCase(benchmark, outcome) {
  const resultObjects = outcome.result?.results ?? [];
  const actualResults = resultObjects.map((result) => result.name).filter(Boolean);
  const actualWinner = actualResults[0] ?? "";
  const expectedTopContenders = benchmark.expectedTopContenders ?? [];
  const expectedWinner = benchmark.expectedWinner ?? "";
  const winnerIsRankOne = expectedWinner ? namesMatch(actualWinner, expectedWinner) : false;
  const winnerInTop3 = expectedWinner ? actualResults.slice(0, 3).some((name) => namesMatch(name, expectedWinner)) : false;
  const contenderMatches = expectedTopContenders.filter((expected) =>
    actualResults.some((actual) => namesMatch(actual, expected))
  );

  return {
    query: benchmark.query,
    category: benchmark.category,
    expectedWinner,
    expectedTopContenders,
    actualWinner,
    actualResults,
    retrievedSourceTitles: benchmark.category === "local_recommendation" ? (outcome.result?.sources ?? []).map((source) => source.title).slice(0, 12) : [],
    extractedCandidates:
      benchmark.category === "local_recommendation"
        ? (outcome.result?.structuredConsensus?.localPlaceExtraction?.candidates ?? [])
            .filter((candidate) => candidate.accepted)
            .map((candidate) => candidate.name)
            .slice(0, 20)
        : [],
    rejectedCandidates:
      benchmark.category === "local_recommendation"
        ? (outcome.result?.structuredConsensus?.localPlaceExtraction?.candidates ?? [])
            .filter((candidate) => !candidate.accepted)
            .map((candidate) => `${candidate.name}: ${candidate.rejectionReason ?? "rejected"}`)
            .slice(0, 20)
        : [],
    finalContenders:
      benchmark.category === "local_recommendation"
        ? (outcome.result?.structuredConsensus?.contenders ?? []).map((contender) => contender.name).slice(0, 10)
        : [],
    localRankingDiagnostics:
      benchmark.category === "local_recommendation"
        ? (outcome.result?.structuredConsensus?.contenders ?? []).slice(0, 10).map((contender, index) => ({
            rank: index + 1,
            name: contender.name,
            score: contender.netWeightedScore,
            sourceCount: contender.sourceCount,
            sourceDomains: contender.localRanking?.sourceDomains ?? contender.sourceUrls ?? [],
            extractionConfidence: contender.localRanking?.extractionConfidence ?? null,
            localRelevanceScore: contender.localRanking?.finalScore ?? contender.netWeightedScore,
            categoryMatchScore: contender.localRanking?.categoryMatchScore ?? null,
            locationMatchScore: contender.localRanking?.locationMatchScore ?? null,
            sourceAuthorityScore: contender.localRanking?.sourceAuthorityScore ?? null,
            crossSourceAgreementCount: contender.localRanking?.crossSourceAgreementCount ?? contender.sourceCount,
            sourceAgreementScore: contender.localRanking?.sourceAgreementScore ?? null,
            weakSingleSourcePenalty: contender.localRanking?.weakSingleSourcePenalty ?? null,
            urlOnlyPenalty: contender.localRanking?.urlOnlyPenalty ?? null
          }))
        : [],
    mode: outcome.result?.mode ?? null,
    cached: outcome.result?.cached ?? null,
    elapsedMs: outcome.elapsedMs,
    error: outcome.error,
    winnerIsRankOne,
    winnerInTop3,
    contenderMatches,
    localTop5Coverage: benchmark.category === "local_recommendation" ? localTop5Coverage(actualResults, expectedTopContenders) : null,
    irrelevantResults: benchmark.category === "local_recommendation" ? localIrrelevantResults(actualResults) : null,
    genericPlaceholders: benchmark.category === "local_recommendation" ? localGenericPlaceholders(actualResults) : null,
    duplicateBusinesses: benchmark.category === "local_recommendation" ? duplicateBusinessCount(actualResults.slice(0, 5)) : null,
    duplicateBusinessDetails:
      benchmark.category === "local_recommendation" ? duplicateBusinessDetails(resultObjects.slice(0, 5)) : [],
    missingObviousContenders:
      benchmark.category === "local_recommendation"
        ? expectedTopContenders.filter((expected) => !actualResults.slice(0, 5).some((actual) => namesMatch(actual, expected)))
        : [],
    localTimeout: benchmark.category === "local_recommendation" ? isLocalTimeout(outcome.error) : false,
    contenderAccuracy: expectedTopContenders.length
      ? contenderMatches.length / expectedTopContenders.length
      : 0
  };
}

function buildReport({ benchmarks, cases, timestamp, commitHash, baseUrl }) {
  const completed = cases.filter((item) => !item.error);
  const winnerHits = cases.filter((item) => item.winnerIsRankOne).length;
  const top3Hits = cases.filter((item) => item.winnerInTop3).length;
  const contenderSlots = cases.reduce((sum, item) => sum + item.expectedTopContenders.length, 0);
  const contenderHits = cases.reduce((sum, item) => sum + item.contenderMatches.length, 0);
  const categories = Array.from(new Set(benchmarks.map((benchmark) => benchmark.category))).sort();
  const byCategory = Object.fromEntries(
    categories.map((category) => {
      const categoryCases = cases.filter((item) => item.category === category);
      const categorySlots = categoryCases.reduce((sum, item) => sum + item.expectedTopContenders.length, 0);
      const categoryHits = categoryCases.reduce((sum, item) => sum + item.contenderMatches.length, 0);
      const localCases = categoryCases.filter((item) => item.category === "local_recommendation");
      const localTop5CoverageAverage = localCases.length
        ? localCases.reduce((sum, item) => sum + (item.localTop5Coverage ?? 0), 0) / localCases.length
        : null;

      return [
        category,
        {
          benchmarks: categoryCases.length,
          winnerAccuracy: ratio(categoryCases.filter((item) => item.winnerIsRankOne).length, categoryCases.length),
          top3Accuracy: ratio(categoryCases.filter((item) => item.winnerInTop3).length, categoryCases.length),
          contenderAccuracy: ratio(categoryHits, categorySlots),
          top5Coverage: localTop5CoverageAverage,
          irrelevantResults: localCases.reduce((sum, item) => sum + (item.irrelevantResults ?? 0), 0),
          genericPlaceholders: localCases.reduce((sum, item) => sum + (item.genericPlaceholders ?? 0), 0),
          duplicateBusinesses: localCases.reduce((sum, item) => sum + (item.duplicateBusinesses ?? 0), 0),
          localTimeouts: localCases.filter((item) => item.localTimeout).length,
          emptyResults: localCases.filter((item) => !item.actualResults.length).length,
          coverageScore: localTop5CoverageAverage
        }
      ];
    })
  );

  return {
    timestamp,
    commitHash,
    baseUrl,
    benchmarkCount: benchmarks.length,
    completedCount: completed.length,
    metrics: {
      winnerAccuracy: ratio(winnerHits, cases.length),
      top3Accuracy: ratio(top3Hits, cases.length),
      contenderAccuracy: ratio(contenderHits, contenderSlots)
    },
    counts: {
      winnerHits,
      top3Hits,
      contenderHits,
      contenderSlots,
      errors: cases.filter((item) => item.error).length
    },
    byCategory,
    failures: cases.filter((item) => isFailure(item)),
    cases
  };
}

function printReport(report) {
  const lines = [
    "",
    "==================================",
    "VERA ACCURACY REPORT",
    "==================================",
    "",
    `Benchmarks: ${report.benchmarkCount}`,
    `Completed: ${report.completedCount}`,
    `Commit: ${report.commitHash}`,
    "",
    "Winner Accuracy:",
    formatMetric(report.counts.winnerHits, report.benchmarkCount, report.metrics.winnerAccuracy),
    "",
    "Top 3 Accuracy:",
    formatMetric(report.counts.top3Hits, report.benchmarkCount, report.metrics.top3Accuracy),
    "",
    "Contender Accuracy:",
    `${Math.round(report.metrics.contenderAccuracy * 100)}%`,
    "",
    "Category Accuracy:"
  ];

  for (const [category, metrics] of Object.entries(report.byCategory)) {
    if (category === "local_recommendation") {
      lines.push(
        `${category}: top 5 coverage ${metrics.top5Coverage === null ? "n/a" : pct(metrics.top5Coverage)}, placeholders ${metrics.genericPlaceholders}, irrelevant ${metrics.irrelevantResults}, duplicates ${metrics.duplicateBusinesses}, timeouts ${metrics.localTimeouts}`
      );
    } else {
      lines.push(
        `${category}: winner ${pct(metrics.winnerAccuracy)}, top 3 ${pct(metrics.top3Accuracy)}, contenders ${pct(metrics.contenderAccuracy)}`
      );
    }
  }

  lines.push("", "Failures:");

  if (report.failures.length === 0) {
    lines.push("None");
  } else {
    for (const failure of report.failures) {
      lines.push("");
      lines.push(failure.query);
      lines.push(`Expected: ${failure.category === "local_recommendation" ? failure.expectedTopContenders.join(", ") : failure.expectedWinner || "n/a"}`);
      lines.push(`Actual: ${failure.actualWinner || failure.error || "none"}`);
      if (failure.actualResults.length) {
        lines.push(`Top results: ${failure.actualResults.slice(0, 5).join(", ")}`);
      }
      if (failure.category === "local_recommendation" && failure.missingObviousContenders?.length) {
        lines.push(`Missing obvious contenders: ${failure.missingObviousContenders.join(", ")}`);
      }
      if (failure.category === "local_recommendation") {
        if (failure.retrievedSourceTitles?.length) lines.push(`Retrieved source titles: ${failure.retrievedSourceTitles.slice(0, 6).join(" | ")}`);
        if (failure.extractedCandidates?.length) lines.push(`Accepted candidates: ${failure.extractedCandidates.slice(0, 10).join(", ")}`);
        if (failure.rejectedCandidates?.length) lines.push(`Rejected candidates: ${failure.rejectedCandidates.slice(0, 8).join(" | ")}`);
        if (failure.finalContenders?.length) lines.push(`Final contenders: ${failure.finalContenders.slice(0, 10).join(", ")}`);
        if (failure.localRankingDiagnostics?.length) {
          lines.push("Local ranking diagnostics:");
          for (const diagnostic of failure.localRankingDiagnostics.slice(0, 5)) {
            lines.push(
              `#${diagnostic.rank} ${diagnostic.name}: score ${diagnostic.score}, sources ${diagnostic.sourceCount}, domains ${diagnostic.sourceDomains.slice(0, 4).join(", ") || "n/a"}, extraction ${diagnostic.extractionConfidence ?? "n/a"}, location ${diagnostic.locationMatchScore ?? "n/a"}, category ${diagnostic.categoryMatchScore ?? "n/a"}, authority ${diagnostic.sourceAuthorityScore ?? "n/a"}, agreement ${diagnostic.crossSourceAgreementCount}, agreementScore ${diagnostic.sourceAgreementScore ?? "n/a"}, weakPenalty ${diagnostic.weakSingleSourcePenalty ?? "n/a"}, urlPenalty ${diagnostic.urlOnlyPenalty ?? "n/a"}`
            );
          }
        }
        if (failure.duplicateBusinessDetails?.length) {
          for (const duplicate of failure.duplicateBusinessDetails) {
            lines.push(
              `Duplicate detail: normalized "${duplicate.normalizedName}" => ${duplicate.rawNames.join(" / ")} | final collapsed contender: ${duplicate.finalCollapsedContender}`
            );
            if (duplicate.sources.length) lines.push(`Duplicate sources: ${duplicate.sources.slice(0, 3).join(" | ")}`);
          }
        }
      }
    }
  }

  lines.push("", "==================================", "");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function logProductBenchmarkSummary(report) {
  const product = report.byCategory.product_recommendation;

  if (!product) {
    return;
  }

  console.log("PRODUCT_BENCHMARK_SUMMARY", {
    benchmarks: product.benchmarks,
    winnerAccuracy: pct(product.winnerAccuracy),
    top3Accuracy: pct(product.top3Accuracy),
    contenderAccuracy: pct(product.contenderAccuracy)
  });
}

function logLocalBenchmarkSummary(report) {
  const local = report.byCategory.local_recommendation;

  if (!local) {
    return;
  }

  console.log("LOCAL_BENCHMARK_SUMMARY", {
    benchmarks: local.benchmarks,
    winnerAccuracy: pct(local.winnerAccuracy),
    top3Accuracy: pct(local.top3Accuracy),
    contenderAccuracy: pct(local.contenderAccuracy),
    TOP5_COVERAGE: local.top5Coverage === null ? "n/a" : pct(local.top5Coverage),
    COVERAGE_SCORE: local.coverageScore === null ? "n/a" : pct(local.coverageScore),
    IRRELEVANT_RESULTS: local.irrelevantResults,
    GENERIC_PLACEHOLDERS: local.genericPlaceholders,
    DUPLICATE_BUSINESSES: local.duplicateBusinesses,
    LOCAL_TIMEOUTS: local.localTimeouts,
    EMPTY_RESULTS: local.emptyResults
  });
}

function isFailure(item) {
  if (item.error) {
    return true;
  }

  if (item.category !== "local_recommendation") {
    return !item.winnerIsRankOne || item.contenderAccuracy < 0.5;
  }

  return (
    !item.actualResults.length ||
    (item.localTop5Coverage ?? 0) < 0.34 ||
    (item.irrelevantResults ?? 0) > 0 ||
    (item.genericPlaceholders ?? 0) > 0 ||
    (item.duplicateBusinesses ?? 0) > 0 ||
    item.localTimeout
  );
}

async function saveReport(report) {
  await mkdir(resultsDir, { recursive: true });
  const filename = `${report.timestamp.slice(0, 10)}-${report.timestamp.slice(11, 19).replaceAll(":", "")}.json`;
  const outputPath = path.join(resultsDir, filename);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Saved benchmark result: ${path.relative(rootDir, outputPath)}\n`);
}

function namesMatch(actual, expected) {
  const actualName = normalizeName(actual);
  const expectedName = normalizeName(expected);

  if (!actualName || !expectedName) {
    return false;
  }

  const expectedAliases = aliasSet(expectedName);
  const actualAliases = aliasSet(actualName);

  if (expectedAliases.has(actualName) || actualAliases.has(expectedName)) {
    return true;
  }

  return (
    actualName.includes(expectedName) ||
    expectedName.includes(actualName) ||
    [...expectedAliases].some((alias) => actualName.includes(alias)) ||
    [...actualAliases].some((alias) => expectedName.includes(alias))
  );
}

function aliasSet(name) {
  const values = new Set([name]);
  const configured = aliases.get(name) ?? [];

  for (const alias of configured) {
    values.add(normalizeName(alias));
  }

  for (const [canonical, canonicalAliases] of aliases.entries()) {
    if (canonicalAliases.map(normalizeName).includes(name)) {
      values.add(normalizeName(canonical));
      canonicalAliases.forEach((alias) => values.add(normalizeName(alias)));
    }
  }

  return values;
}

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|app|software|service|platform|inc|llc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localTop5Coverage(actualResults, expectedTopContenders) {
  if (!expectedTopContenders.length) {
    return 0;
  }

  const top5 = actualResults.slice(0, 5);
  const matches = expectedTopContenders.filter((expected) => top5.some((actual) => namesMatch(actual, expected)));
  return matches.length / expectedTopContenders.length;
}

function duplicateBusinessCount(results) {
  const seen = new Set();
  let duplicates = 0;

  for (const result of results) {
    const key = normalizeLocalBusinessName(result);

    if (!key) {
      continue;
    }

    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }

    seen.add(key);
  }

  return duplicates;
}

function duplicateBusinessDetails(results) {
  const groups = new Map();

  for (const result of results) {
    const name = typeof result === "string" ? result : result?.name;
    const key = normalizeLocalBusinessName(name);

    if (!key) {
      continue;
    }

    const group = groups.get(key) ?? {
      normalizedName: key,
      rawNames: [],
      sources: [],
      finalCollapsedContender: name
    };

    group.rawNames.push(name);
    group.finalCollapsedContender = preferredLocalDisplayName(group.finalCollapsedContender, name);

    for (const source of result?.sources ?? []) {
      const sourceLabel = [source.title, source.url].filter(Boolean).join(" - ");
      if (sourceLabel) group.sources.push(sourceLabel);
    }

    groups.set(key, group);
  }

  return Array.from(groups.values())
    .filter((group) => new Set(group.rawNames).size > 1 || group.rawNames.length > 1)
    .map((group) => ({
      ...group,
      rawNames: Array.from(new Set(group.rawNames)),
      sources: Array.from(new Set(group.sources))
    }));
}

function preferredLocalDisplayName(current, candidate) {
  const currentWords = normalizeName(current).split(" ").filter(Boolean).length;
  const candidateWords = normalizeName(candidate).split(" ").filter(Boolean).length;

  if (!current) return candidate;
  if (candidateWords >= 2 && currentWords < 2) return candidate;
  if (currentWords >= 2 && candidateWords < 2) return current;
  if (candidate.length < current.length && candidateWords >= currentWords) return candidate;
  return current;
}

function localIrrelevantResults(results) {
  return results.slice(0, 5).filter((result) => isGenericLocalResult(result)).length;
}

function localGenericPlaceholders(results) {
  return results.slice(0, 5).filter((result) => isGenericLocalResult(result)).length;
}

function isGenericLocalResult(result) {
  const normalized = normalizeLocalBusinessName(result);

  return (
    !normalized ||
    /^(restaurant|restaurants|hotel|hotels|bar|bars|coffee|coffee shop|pizza|brunch|bakery|bakeries|gym|gyms|dentist|dentists|plumber|plumbers|attraction|attractions|golf course|golf courses|public courses|best|top|unknown|none|the|read|avenue|street|st|ave|nyc|short visit|what to visit|places to stay|places to eat|booking com|tripadvisor|yelp|google maps|recommendations|recs|comments?|replies|threads?|restaurant reviews?|(?:the )?best restaurant|(?:the )?best restaurants|(?:the )?best .+|best coffee cafe|updated \d{4}|rankings|ranking|eater|eater new york|eater san francisco|infatuation|the infatuation|healthgrades|time out|timeout|time out new yorks?|new york city|new york|manhattan|brooklyn|williamsburg|williamsburg right now|long island|austin|seattle|los angeles|san francisco|massapequa|what they are saying|brunch|biz|came)$/.test(
      normalized
    ) ||
    /^r\s+\w+$/.test(normalized) ||
    /\b(recommendations? for|dinner date recommendations?|date recommendations?|what to visit|days in|places to stay|places to eat|recs|what are your favorite|courses? ranked|public courses? ranked|favorite public courses?|favorite bakeries?|lunch spot ideas|first date options|date ?night|family friendly dining|manhattan with kids|good eats for families|beautiful cafes|cafes in|cafés in|recommended bakeries|do you like your gym|world s 100 greatest|rankings?|guide|best of|local guide)\b/.test(
      normalized
    ) ||
    /\b(brooks ghost|nike pegasus|asics gel|hoka clifton|best plumbing)$/.test(normalized) ||
    (/\b(options?|ideas?|spots?|guide|rankings?|reviews?|recommendations?)\b/.test(normalized) && normalized.split(" ").length >= 3)
  );
}

function isLocalTimeout(error) {
  return Boolean(error && /timeout|timed out|abort|fetch failed|network/i.test(String(error)));
}

function normalizeLocalBusinessName(value) {
  let normalized = normalizeName(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(review|reviews|menu|reservation|reservations|photos|ratings|tripadvisor|yelp|opentable|booking|google|maps|reddit|eater|infatuation|best|top|near me|official site|article|story|guide)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  normalized = normalized
    .replace(/\s+\b(location|branch|restaurant|bar|cafe|coffee shop|hotel|inn|gym|fitness|dentist|dental|plumber|plumbing|bakery|pizzeria)\b$/g, "")
    .replace(
      /\s+\b(williamsburg|brooklyn|manhattan|nyc|new york|los angeles|austin|seattle|massapequa|downtown|midtown|uptown|greenwich village|carmine st|street|avenue|road)\b$/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  return normalized;
}

function getCommitHash() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatMetric(numerator, denominator, value) {
  return `${numerator} / ${denominator} (${pct(value)})`;
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (!existsSync(benchmarkFile)) {
  throw new Error(`Missing benchmark file: ${benchmarkFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

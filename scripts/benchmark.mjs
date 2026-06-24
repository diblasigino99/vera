import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const benchmarkFile = path.join(rootDir, "benchmarks", "consensus-benchmarks.json");
const resultsDir = path.join(rootDir, "benchmarks", "results");
const defaultPort = Number(process.env.BENCHMARK_PORT ?? 3117);
const requestTimeoutMs = Number(process.env.BENCHMARK_REQUEST_TIMEOUT_MS ?? 90000);

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
  const actualResults = outcome.result?.results?.map((result) => result.name).filter(Boolean) ?? [];
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
    mode: outcome.result?.mode ?? null,
    cached: outcome.result?.cached ?? null,
    elapsedMs: outcome.elapsedMs,
    error: outcome.error,
    winnerIsRankOne,
    winnerInTop3,
    contenderMatches,
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

      return [
        category,
        {
          benchmarks: categoryCases.length,
          winnerAccuracy: ratio(categoryCases.filter((item) => item.winnerIsRankOne).length, categoryCases.length),
          top3Accuracy: ratio(categoryCases.filter((item) => item.winnerInTop3).length, categoryCases.length),
          contenderAccuracy: ratio(categoryHits, categorySlots)
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
    failures: cases.filter(
      (item) => item.error || !item.winnerIsRankOne || item.contenderAccuracy < 0.5
    ),
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
    lines.push(
      `${category}: winner ${pct(metrics.winnerAccuracy)}, top 3 ${pct(metrics.top3Accuracy)}, contenders ${pct(metrics.contenderAccuracy)}`
    );
  }

  lines.push("", "Failures:");

  if (report.failures.length === 0) {
    lines.push("None");
  } else {
    for (const failure of report.failures) {
      lines.push("");
      lines.push(failure.query);
      lines.push(`Expected: ${failure.expectedWinner || "n/a"}`);
      lines.push(`Actual: ${failure.actualWinner || failure.error || "none"}`);
      if (failure.actualResults.length) {
        lines.push(`Top results: ${failure.actualResults.slice(0, 5).join(", ")}`);
      }
    }
  }

  lines.push("", "==================================", "");
  process.stdout.write(`${lines.join("\n")}\n`);
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

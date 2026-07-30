import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { diagnoseMultiContenderSplitEvidence } from "../lib/server/consensus-classification.ts";
import { canonicalDestinationName, destinationCandidateFitsQuery, destinationCandidateProof, extractDestinationCandidatesFromText, isGenericDestinationContenderName } from "../lib/server/destination-rules.ts";

const root = process.cwd();
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(root, request.slice(2)), parent, isMain, options);
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const jiti = (await import("jiti")).default(process.cwd() + "/");
const {
  buildProductFallbackConsensus,
  enforceDisplayableSplitConsensusInvariant,
  filterCompatibleEntityNamesForRegression,
  filterCompatibleSoftwareSignalsForRegression,
  localFallbackEvidenceEligibilityForRegression,
  localSubtypeProofForRegression,
  productOpinionAggregationScopeForRegression,
  preserveEvidenceBackedProductContendersForRegression,
  recoverDestinationSignalsForRegression,
  resolveEntityNamesForRegression,
  resolveProductEntitySignalsForRegression,
  sanitizeCachedLocalConsensus,
  selectNoReliableConsensusDisplayContendersForRegression,
  trimForOpenAIRegression
} = jiti("./lib/server/analyze.ts");
const { compareConsensusSourceSelectionForRegression } = jiti("./lib/server/search.ts");
const { inferQueryEvidenceType } = jiti("./lib/utils.ts");
const { attachContenderActions } = jiti("./lib/action-links.ts");

const minimumSourceCount = 3;
const minimumTopPositiveMentions = 3;
const minimumTopSourceCount = 3;

function contender(name, { positives = 1, negatives = 0, sourceUrls = [], quality = 3, score = 10 } = {}) {
  return {
    name,
    contenderCategory: "other",
    categoryConfidence: "medium",
    mentionCount: positives + negatives,
    positiveMentionCount: positives,
    negativeMentionCount: negatives,
    sourceCount: sourceUrls.length,
    sourceDiversityScore: Math.min(sourceUrls.length, 3),
    sourceQualityScore: quality,
    strongMentionCount: 0,
    editorialSupportCount: positives,
    communitySupportCount: 0,
    weightedPositiveScore: score,
    weightedNegativeScore: negatives,
    netWeightedScore: score,
    sourceTypes: ["editorial"],
    themeCounts: [],
    sourceUrls
  };
}

function consensusFixture({ mode = "split_consensus", results = [], contenders = null, signals = [], query = "best local option" } = {}) {
  const structuredContenders = contenders ?? results.map((result) => result.metrics);

  return {
    id: "regression-consensus",
    query,
    normalizedQuery: query.toLowerCase(),
    canonicalQuery: query.toLowerCase(),
    mode,
    headline: mode === "split_consensus" ? "The internet is divided." : "No Clear Consensus",
    explanation: "Regression fixture",
    intent: {
      category: "Decision",
      constraints: [],
      optimizeFor: [],
      avoid: []
    },
    results,
    sources: [
      {
        title: "Regression source",
        url: "regression://source",
        domain: "regression"
      }
    ],
    structuredConsensus: {
      intendedCategory: "restaurant",
      queryEvidenceType: "local_recommendation",
      evidenceStrategy: "regression",
      contenders: structuredContenders,
      mentionCounts: {},
      themeCounts: {},
      sourceBreakdown: {
        reddit: 0,
        forum: 0,
        review_site: 0,
        editorial: 1,
        local_guide: 0,
        professional_review: 0,
        official: 0,
        other: 0
      },
      confidenceReasoning: "regression",
      consensusClassification: mode,
      signals
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    cached: false
  };
}

function resultFromContender(item, index = 0) {
  return {
    id: `${item.name.toLowerCase().replace(/\s+/g, "-")}-${index + 1}`,
    rank: index + 1,
    name: item.name,
    consensusPercentage: 10,
    summary: "Regression contender with positive evidence.",
    reasons: ["Recurring recommendation"],
    downsides: [],
    evidence: ["Positive attributed evidence."],
    sources: [
      {
        title: "Regression source",
        url: item.sourceUrls[0] ?? "regression://source",
        domain: "regression"
      }
    ],
    metrics: item,
    verifiedAddress: "284 Grand St, Brooklyn, NY 11211, USA"
  };
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }

  return false;
}

function assertOpenAITrimSafe(input, maxChars, expected, message) {
  const output = trimForOpenAIRegression(input, maxChars);
  assert.equal(hasUnpairedSurrogate(output), false, `${message}: output should not contain unpaired surrogates`);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ messages: [{ role: "user", content: output }] })), `${message}: output should serialize as JSON`);
  assert.equal(output, expected, message);
}

function source(title, url, domain, snippet = "", supportingContender = undefined) {
  return {
    title,
    url,
    domain,
    snippet,
    supportingContender
  };
}

assertOpenAITrimSafe("abc😀def", 4, "abc...", "Emoji split at trim boundary should be removed safely with ellipsis");
assertOpenAITrimSafe("abc😀def", 5, "abc😀...", "Emoji fitting before trim boundary should be preserved");
assertOpenAITrimSafe("a😀b🚀c", 5, "a😀b...", "Multiple emoji should truncate without splitting");
assertOpenAITrimSafe("café mañana", 20, "café mañana", "Accented Latin text should remain unchanged");
assertOpenAITrimSafe("東京 京都 大阪", 20, "東京 京都 大阪", "Non-Latin valid Unicode should remain unchanged");
assertOpenAITrimSafe("plain   ascii\ntext", 40, "plain ascii text", "Short ASCII text should preserve existing whitespace normalization");
assertOpenAITrimSafe("plain ascii text that is long", 12, "plain ascii...", "Long ASCII text should truncate with ellipsis");
assertOpenAITrimSafe(`abc${String.fromCharCode(0xd83c)}def`, 20, "abcdef", "Already malformed high surrogate should be removed without corrupting surrounding text");
assertOpenAITrimSafe(`abc${String.fromCharCode(0xdc00)}def`, 20, "abcdef", "Already malformed low surrogate should be removed without corrupting surrounding text");
assertOpenAITrimSafe(`Brevo G2: 4.5 ${String.fromCodePoint(0x1f4a1)} reviews`, 15, "Brevo G2: 4.5...", "Mailtrap-style emoji boundary should not produce invalid JSON");

const actionProductA = contender("Away Carry-On", {
  positives: 3,
  sourceUrls: ["https://www.awaytravel.com/suitcases/carry-on"]
});
actionProductA.contenderCategory = "product";
const actionProductB = contender("Travelpro Platinum Elite", {
  positives: 2,
  sourceUrls: ["https://www.travelpro.com/collections/platinum-elite"]
});
actionProductB.contenderCategory = "product";
const splitProductActions = consensusFixture({
  mode: "split_consensus",
  query: "best carry on luggage",
  contenders: [actionProductA, actionProductB],
  results: [actionProductA, actionProductB].map(resultFromContender)
});
splitProductActions.structuredConsensus.queryEvidenceType = "product_recommendation";
splitProductActions.sources = [
  source("Away Carry-On", "https://www.awaytravel.com/suitcases/carry-on", "awaytravel.com", "Away Carry-On product page.", "Away Carry-On"),
  source("Travelpro Platinum Elite", "https://www.travelpro.com/collections/platinum-elite", "travelpro.com", "Travelpro Platinum Elite product page.", "Travelpro Platinum Elite")
];
splitProductActions.results[0].sources = [splitProductActions.sources[0]];
splitProductActions.results[1].sources = [splitProductActions.sources[1]];

const decoratedSplitProductActions = attachContenderActions(splitProductActions);
assert.equal(decoratedSplitProductActions.mode, splitProductActions.mode, "Action links must not change consensus classification");
assert.deepEqual(
  decoratedSplitProductActions.results.map((item) => item.name),
  splitProductActions.results.map((item) => item.name),
  "Action links must not change contender order"
);
assert.deepEqual(
  decoratedSplitProductActions.results.map((item) => item.action?.label),
  ["View Product", "View Product"],
  "Every displayed split-consensus product contender can independently receive View Product"
);

const noClearProductActions = consensusFixture({
  mode: "no_reliable_consensus",
  query: "best water bottle brand",
  contenders: [actionProductA],
  results: [resultFromContender(actionProductA)]
});
noClearProductActions.structuredConsensus.queryEvidenceType = "product_recommendation";
noClearProductActions.sources = [splitProductActions.sources[0]];
noClearProductActions.results[0].sources = [splitProductActions.sources[0]];
assert.equal(
  attachContenderActions(noClearProductActions).results[0].action?.label,
  "View Product",
  "No-clear evidence-backed contenders can receive product actions"
);

const missingUrlActions = consensusFixture({
  mode: "strong_consensus",
  query: "best coffee machine",
  contenders: [actionProductA],
  results: [resultFromContender(actionProductA)]
});
missingUrlActions.structuredConsensus.queryEvidenceType = "product_recommendation";
missingUrlActions.sources = [source("Editorial review", "https://www.nytimes.com/wirecutter/reviews/best-coffee-maker", "nytimes.com", "A review mentions Away Carry-On.")];
missingUrlActions.results[0].sources = missingUrlActions.sources;
assert.equal(
  attachContenderActions(missingUrlActions).results[0].action,
  undefined,
  "Missing or unverified URLs should not create an action"
);

const softwareActionContender = contender("HubSpot", { positives: 3, sourceUrls: ["https://www.hubspot.com/products/crm"] });
softwareActionContender.contenderCategory = "software";
const softwareActions = consensusFixture({
  mode: "strong_consensus",
  query: "best crm software",
  contenders: [softwareActionContender],
  results: [resultFromContender(softwareActionContender)]
});
softwareActions.structuredConsensus.queryEvidenceType = "software_tool";
softwareActions.sources = [source("HubSpot CRM", "https://www.hubspot.com/products/crm", "hubspot.com", "HubSpot CRM official website.", "HubSpot")];
softwareActions.results[0].sources = softwareActions.sources;
assert.equal(attachContenderActions(softwareActions).results[0].action?.label, "Visit Website", "Software actions use Visit Website");

const localActionContender = contender("Oregano", { positives: 2, sourceUrls: ["https://www.oreganobk.com"] });
localActionContender.contenderCategory = "restaurant";
const localActions = consensusFixture({
  mode: "moderate_consensus",
  query: "best italian restaurant in williamsburg",
  contenders: [localActionContender],
  results: [resultFromContender(localActionContender)]
});
localActions.structuredConsensus.queryEvidenceType = "local_recommendation";
localActions.sources = [source("Oregano", "https://www.oreganobk.com", "oreganobk.com", "Oregano official website.", "Oregano")];
localActions.results[0].sources = localActions.sources;
assert.equal(attachContenderActions(localActions).results[0].action?.label, "Website", "Local actions use Website");

const providerActionContender = contender("Verizon Fios", { positives: 2, sourceUrls: ["https://www.verizon.com/home/internet/fios"] });
providerActionContender.contenderCategory = "service";
const providerActions = consensusFixture({
  mode: "moderate_consensus",
  query: "best internet provider",
  contenders: [providerActionContender],
  results: [resultFromContender(providerActionContender)]
});
providerActions.structuredConsensus.queryEvidenceType = "provider_or_brand_recommendation";
providerActions.sources = [source("Verizon Fios", "https://www.verizon.com/home/internet/fios", "verizon.com", "Verizon Fios official website.", "Verizon Fios")];
providerActions.results[0].sources = providerActions.sources;
assert.equal(attachContenderActions(providerActions).results[0].action?.label, "Visit Website", "Provider actions use Visit Website");

const destinationContender = contender("Valencia", { positives: 2, sourceUrls: ["https://www.visitvalencia.com"] });
destinationContender.contenderCategory = "other";
const destinationActions = consensusFixture({
  mode: "no_reliable_consensus",
  query: "best city to visit in spain",
  contenders: [destinationContender],
  results: [resultFromContender(destinationContender)]
});
destinationActions.structuredConsensus.queryEvidenceType = "destination_recommendation";
destinationActions.sources = [source("Visit Valencia", "https://www.visitvalencia.com", "visitvalencia.com", "Official Valencia visitor guide.", "Valencia")];
destinationActions.results[0].sources = destinationActions.sources;
assert.equal(attachContenderActions(destinationActions).results[0].action, undefined, "Destination entities should not receive forced action links");

const analyzeSource = fs.readFileSync(path.join(root, "lib/server/analyze.ts"), "utf8");
assert.equal(analyzeSource.includes("attachContenderActions"), false, "Consensus analysis must not reference the action-link presentation layer");

console.log(
  JSON.stringify(
    {
      openAIUnicodeTrim: {
        emojiBoundary: trimForOpenAIRegression("abc😀def", 4),
        emojiPreserved: trimForOpenAIRegression("abc😀def", 5),
        mailtrapBoundary: trimForOpenAIRegression(`Brevo G2: 4.5 ${String.fromCodePoint(0x1f4a1)} reviews`, 15)
      }
    },
    null,
    2
  )
);

function classifyRegressionCase({ query, evidenceType, contenders, sourceCount, isBroadExploratoryProductQuery = false }) {
  if (sourceCount < minimumSourceCount || contenders.length === 0) {
    return { mode: "no_reliable_consensus", diagnostics: null };
  }

  const diagnostics = diagnoseMultiContenderSplitEvidence(contenders, evidenceType, { isBroadExploratoryProductQuery });
  const top = contenders[0];

  if (!diagnostics.supported && (diagnostics.totalPositiveMentions < 3 || diagnostics.positiveSourceCount < 3)) {
    return { mode: "no_reliable_consensus", diagnostics };
  }

  if (evidenceType === "destination_recommendation" && !diagnostics.supported) {
    return { mode: "no_reliable_consensus", diagnostics };
  }

  const topHasEnoughEvidence = top.positiveMentionCount >= minimumTopPositiveMentions && top.sourceCount >= minimumTopSourceCount;

  if (!topHasEnoughEvidence) {
    return { mode: "split_consensus", diagnostics };
  }

  return { mode: "split_consensus", diagnostics };
}

function destinationContendersFromSources(query, sources) {
  const bySourceAndName = new Map();
  const repeatedContextual = new Map();

  for (const source of sources) {
    const text = `${source.title}. ${source.snippet}`;

    for (const rawCandidate of extractDestinationCandidatesFromText(text)) {
      const proof = destinationCandidateProof(query, rawCandidate, [source.title, source.snippet]);
      const name = proof.canonicalName;

      if (!proof.accepted) {
        continue;
      }

      if (proof.requiresMultipleSources) {
        const items = repeatedContextual.get(name) ?? [];
        if (!items.some((item) => item.sourceUrl === source.url)) {
          items.push({ name, sourceUrl: source.url, sourceQuality: source.sourceQuality ?? 1.2 });
          repeatedContextual.set(name, items);
        }
        continue;
      }

      bySourceAndName.set(`${source.url}::${name.toLowerCase()}`, { name, sourceUrl: source.url, sourceQuality: source.sourceQuality ?? 1.2 });
    }
  }

  for (const items of repeatedContextual.values()) {
    if (new Set(items.map((item) => item.sourceUrl)).size < 2) {
      continue;
    }

    for (const item of items) {
      bySourceAndName.set(`${item.sourceUrl}::${item.name.toLowerCase()}`, item);
    }
  }

  const byName = new Map();

  for (const signal of bySourceAndName.values()) {
    const item = byName.get(signal.name) ?? { name: signal.name, sourceUrls: [], quality: 0, positives: 0, score: 0 };
    item.sourceUrls.push(signal.sourceUrl);
    item.quality += signal.sourceQuality;
    item.positives += 1;
    item.score += signal.sourceQuality * 4;
    byName.set(signal.name, item);
  }

  return Array.from(byName.values())
    .map((item) =>
      contender(item.name, {
        positives: item.positives,
        sourceUrls: item.sourceUrls,
        quality: item.quality,
        score: item.score
      })
    )
    .sort((a, b) => b.netWeightedScore - a.netWeightedScore || b.sourceCount - a.sourceCount || a.name.localeCompare(b.name));
}

const cases = [
  {
    query: "Best all inclusive Caribbean island",
    evidenceType: "destination_recommendation",
    expectedMode: "split_consensus",
    contenders: [
      contender("St. Lucia", { sourceUrls: ["cntraveler", "ricksteves"], score: 14, positives: 2 }),
      contender("Antigua", { sourceUrls: ["reddit"], score: 9 }),
      contender("Jamaica", { sourceUrls: ["forbes"], score: 9 }),
      contender("Aruba", { sourceUrls: ["reddit-2"], score: 8 })
    ]
  },
  {
    query: "Best Caribbean island for all inclusive resorts",
    evidenceType: "destination_recommendation",
    expectedMode: "split_consensus",
    contenders: [
      contender("St. Lucia", { sourceUrls: ["cntraveler", "community"], score: 14, positives: 2 }),
      contender("Dominican Republic", { sourceUrls: ["tripadvisor"], score: 10 }),
      contender("Jamaica", { sourceUrls: ["reddit"], score: 9 }),
      contender("Antigua", { sourceUrls: ["reddit-2"], score: 8 })
    ]
  },
  {
    query: "Best luxury carry on luggage",
    evidenceType: "product_recommendation",
    expectedMode: "split_consensus",
    contenders: [
      contender("Rimowa Cabin", { sourceUrls: ["wirecutter", "forbes"], score: 13, positives: 2 }),
      contender("Away Bigger Carry-On", { sourceUrls: ["travelandleisure"], score: 10 }),
      contender("Briggs & Riley Baseline", { sourceUrls: ["cntraveler"], score: 9 })
    ]
  },
  {
    query: "Best CRM software",
    evidenceType: "software_tool",
    expectedMode: "split_consensus",
    contenders: [
      contender("Salesforce", { sourceUrls: ["g2", "pcmag"], score: 13, positives: 2 }),
      contender("HubSpot", { sourceUrls: ["capterra"], score: 10 }),
      contender("Pipedrive", { sourceUrls: ["reddit"], score: 9 })
    ]
  },
  {
    query: "Best unknown product nobody talks about",
    evidenceType: "product_recommendation",
    expectedMode: "no_reliable_consensus",
    contenders: [contender("Obscure Gadget", { sourceUrls: ["single-source"], quality: 1.2, score: 4 })]
  },
  {
    query: "Best beaches in Portugal for vacation",
    evidenceType: "destination_recommendation",
    expectedMode: "no_reliable_consensus",
    contenders: [
      contender("Barra", { sourceUrls: ["single-aveiro-guide"], quality: 3, score: 2.8 }),
      contender("Costa Nova", { sourceUrls: ["single-aveiro-guide"], quality: 3, score: 2.8 }),
      contender("Vagueira", { sourceUrls: ["single-aveiro-guide"], quality: 3, score: 2.8 })
    ]
  }
];

for (const testCase of cases) {
  const result = classifyRegressionCase({
    ...testCase,
    sourceCount: 5
  });

  assert.equal(result.mode, testCase.expectedMode, `${testCase.query} should classify as ${testCase.expectedMode}`);

  if (testCase.expectedMode === "split_consensus") {
    assert.equal(result.diagnostics?.supported, true, `${testCase.query} should pass multi-contender diagnostics`);
  }

  if (testCase.expectedMode === "no_reliable_consensus") {
    assert.notEqual(result.diagnostics?.supported, true, `${testCase.query} should not pass multi-contender diagnostics`);
  }

  console.log(
    JSON.stringify(
      {
        query: testCase.query,
        evidenceType: testCase.evidenceType,
        mode: result.mode,
        diagnostics: result.diagnostics
      },
      null,
      2
    )
  );
}

const caribbeanText = [
  "St. Lucia to Jamaica, these are the best all-inclusive resorts in the Caribbean.",
  "Our top recommendation is Sugar Beach, A Viceroy Resort in St. Lucia.",
  "We also recommend Curtain Bluff in Antigua.",
  "Anguilla, Aruba, Grand Cayman, and the Exuma Bahamas are repeatedly mentioned."
].join(" ");
const caribbeanCandidates = extractDestinationCandidatesFromText(caribbeanText).map(canonicalDestinationName);
const acceptedCaribbeanCandidates = caribbeanCandidates.filter((candidate) => destinationCandidateFitsQuery("Best all inclusive Caribbean island", candidate, [caribbeanText]));

for (const expected of ["St. Lucia", "Jamaica", "Antigua", "Anguilla", "Aruba", "Grand Cayman", "Bahamas"]) {
  assert.ok(caribbeanCandidates.includes(expected), `Expected destination extraction to include ${expected}`);
}

const entityResolutionCases = [
  {
    query: "Best laptop brand",
    evidenceType: "provider_or_brand_recommendation",
    names: ["Apple", "Apple Inc.", "Apple MacBook Air", "MacBooks"],
    expectedNames: ["Apple"],
    expectedActions: ["merged", "downgraded"]
  },
  {
    query: "Best productivity suite",
    evidenceType: "product_recommendation",
    names: ["Microsoft", "Microsoft 365", "Microsoft 365 Family"],
    expectedNames: ["Microsoft 365"],
    expectedActions: ["merged"]
  },
  {
    query: "Best business email",
    evidenceType: "product_recommendation",
    names: ["Google", "Google Workspace", "G Suite"],
    expectedNames: ["Google Workspace"],
    expectedActions: ["merged"]
  },
  {
    query: "Best CRM software",
    evidenceType: "software_tool",
    names: ["Salesforce", "Salesforce CRM"],
    expectedNames: ["Salesforce CRM"],
    expectedActions: ["merged"]
  },
  {
    query: "Best internet provider",
    evidenceType: "product_recommendation",
    names: ["Verizon", "Verizon Fios"],
    expectedNames: ["Verizon Fios"],
    expectedActions: ["merged"]
  },
  {
    query: "Best laptop",
    evidenceType: "product_recommendation",
    names: ["Apple", "Apple MacBook Air", "MacBook Pro"],
    expectedNames: ["Apple MacBook Air", "MacBook Pro"],
    expectedActions: ["rejected"]
  },
  {
    query: "best water bottle brand",
    evidenceType: "product_recommendation",
    names: [
      "Hydro Flask",
      "Hydroflask",
      "HydroFlask",
      "Hydro Flask Standard Flex",
      "Yeti Rambler Water Bottle",
      "YETI",
      "Takeya",
      "Coleman Free Flow Autoseal",
      "coleman free flow autoseal bottle"
    ],
    expectedNames: ["Hydro Flask", "Yeti", "Takeya", "Coleman"],
    expectedActions: ["merged", "downgraded"]
  },
  {
    query: "best luggage brand",
    evidenceType: "product_recommendation",
    names: ["Travel Pro", "Travelpro", "Travelpro Platinum Elite"],
    expectedNames: ["Travelpro"],
    expectedActions: ["merged", "downgraded"]
  },
  {
    query: "best backpack brand",
    evidenceType: "product_recommendation",
    names: ["North Face", "The North Face", "The North Face Borealis Backpack"],
    expectedNames: ["The North Face"],
    expectedActions: ["merged", "downgraded"]
  },
  {
    query: "is hydro flask worth it",
    evidenceType: "product_recommendation",
    names: ["Hydro Flask", "Hydroflask", "Hydro Flask Trail Series"],
    expectedNames: ["Hydro Flask"],
    expectedActions: ["merged", "downgraded"]
  },
  {
    query: "is away luggage worth it",
    evidenceType: "product_recommendation",
    names: ["Away luggage", "Away Carry-On", "Away The Carry-On"],
    expectedNames: ["Away"],
    expectedActions: ["downgraded"]
  },
  {
    query: "best Hydro Flask water bottle",
    evidenceType: "product_recommendation",
    names: ["Hydro Flask Standard Flex", "Hydro Flask Trail Series"],
    expectedNames: ["Hydro Flask Standard Flex", "Hydro Flask Trail Series"],
    expectedActions: ["accepted"]
  },
  {
    query: "best carry on luggage",
    evidenceType: "product_recommendation",
    names: ["Away Carry-On", "Travelpro Platinum Elite", "Monos Carry-On"],
    expectedNames: ["Away Carry-On", "Travelpro Platinum Elite", "Monos Carry-On"],
    expectedActions: ["accepted"]
  },
  {
    query: "best coffee machine",
    evidenceType: "product_recommendation",
    names: ["Breville Bambino Plus", "Breville Barista Express", "Gaggia Classic Pro"],
    expectedNames: ["Breville Bambino Plus", "Breville Barista Express", "Gaggia Classic Pro"],
    expectedActions: ["accepted"]
  },
  {
    query: "best running shoes",
    evidenceType: "product_recommendation",
    names: ["Brooks Ghost", "Nike Pegasus", "Asics Gel-Nimbus", "Hoka Clifton"],
    expectedNames: ["Brooks Ghost", "Nike Pegasus", "Asics Gel-Nimbus", "Hoka Clifton"],
    expectedActions: ["accepted"]
  }
];

for (const item of entityResolutionCases) {
  const resolved = resolveEntityNamesForRegression(item.query, item.evidenceType, item.names);
  assert.deepEqual(resolved.resolvedNames.sort(), item.expectedNames.sort(), `${item.query} should resolve to requested entity-level contenders`);

  for (const action of item.expectedActions) {
    assert.ok(resolved.diagnostics.some((diagnostic) => diagnostic.action === action), `${item.query} should include ${action} resolution diagnostic`);
  }

  console.log(JSON.stringify({ entityResolution: { query: item.query, resolvedNames: resolved.resolvedNames, diagnostics: resolved.diagnostics } }, null, 2));
}

const waterBottleSameSourceRollup = resolveProductEntitySignalsForRegression("best water bottle brand", [
  { name: "Hydro Flask", sourceUrl: "regression://same-review" },
  { name: "Hydroflask", sourceUrl: "regression://same-review" },
  { name: "Hydro Flask Standard Flex", sourceUrl: "regression://same-review" },
  { name: "Yeti Rambler Water Bottle", sourceUrl: "regression://yeti-review" }
]);
assert.deepEqual(
  waterBottleSameSourceRollup.resolvedSignals.filter((signal) => signal.name === "Hydro Flask"),
  [{ name: "Hydro Flask", sourceUrl: "regression://same-review" }],
  "Brand rollup should not double-count parent and child evidence from the same source"
);
assert.equal(waterBottleSameSourceRollup.sourceCounts["Hydro Flask"], 1, "Hydro Flask same-source rollup should count one independent source");
assert.equal(waterBottleSameSourceRollup.sourceCounts.Yeti, 1, "Yeti child rollup should retain its independent source");

console.log(JSON.stringify({ productEntitySourceDeduplication: waterBottleSameSourceRollup }, null, 2));

const routingRegressionCases = [
  { query: "best coffee machine", expectedEvidenceType: "product_recommendation" },
  { query: "best coffee shop in brooklyn", expectedEvidenceType: "local_recommendation" },
  { query: "is rome overrated", expectedEvidenceType: "destination_recommendation" },
  { query: "best running shoes", expectedEvidenceType: "product_recommendation" },
  { query: "best note taking app", expectedEvidenceType: "software_tool" },
  { query: "is away luggage worth it", expectedEvidenceType: "product_recommendation" },
  { query: "is salesforce still the best crm", expectedEvidenceType: "software_tool" },
  { query: "best dentist in austin", expectedEvidenceType: "local_recommendation" }
];

for (const item of routingRegressionCases) {
  const evidenceType = inferQueryEvidenceType(item.query);
  assert.equal(evidenceType, item.expectedEvidenceType, `${item.query} should route as ${item.expectedEvidenceType}`);
}

console.log(JSON.stringify({ routingRegression: routingRegressionCases }, null, 2));

const waterBottlePreserved = preserveEvidenceBackedProductContendersForRegression("best water bottle brand", ["Takeya", "Yeti", "Hydro Flask", "Stanley", "Owala"]);
for (const expected of ["Takeya", "Yeti", "Hydro Flask", "Stanley", "Owala"]) {
  assert.ok(waterBottlePreserved.includes(expected), `Broad-product preservation should retain ${expected} when cleanup would empty the set`);
}

const mattressPreserved = preserveEvidenceBackedProductContendersForRegression("best mattress", ["Helix Midnight Luxe"]);
assert.deepEqual(mattressPreserved, ["Helix Midnight Luxe"], "Broad-product preservation should retain a valid mattress contender when cleanup would empty the set");

console.log(JSON.stringify({ broadProductPreservation: { waterBottlePreserved, mattressPreserved } }, null, 2));

const aiCodingCompatibility = filterCompatibleSoftwareSignalsForRegression("best ai coding assistant", [
  { name: "Honda Pilot", reason: "listed as an SUV in an automotive comparison", sourceTitle: "Best vehicles tested" },
  { name: "Claude Code", reason: "recommended for complex refactoring and code generation", sourceTitle: "Best AI coding assistants" },
  { name: "Cursor", reason: "recommended as a coding assistant for daily IDE work", sourceTitle: "Best AI coding assistants" },
  { name: "ChatGPT", reason: "produces useful code and programming help", sourceTitle: "Best AI coding assistants" }
]);
assert.equal(aiCodingCompatibility.compatibleNames.includes("Honda Pilot"), false, "Software queries should reject clear vehicle entities");
assert.ok(aiCodingCompatibility.compatibleNames.includes("Claude Code"), "Software queries should retain software/tool entities");
assert.ok(aiCodingCompatibility.compatibleNames.includes("Cursor"), "Software queries should retain software/tool entities");
assert.ok(aiCodingCompatibility.compatibleNames.includes("ChatGPT"), "Software queries should retain supported coding-assistant entities");
assert.ok(
  aiCodingCompatibility.diagnostics.some((diagnostic) => diagnostic.originalName === "Honda Pilot" && diagnostic.validator === "requested_entity_type_compatibility"),
  "Software compatibility rejection should produce diagnostics"
);

const noteTakingCompatibility = filterCompatibleSoftwareSignalsForRegression("best note taking app", [
  { name: "GoodNotes", reason: "recommended for handwritten notes and study notebooks", sourceTitle: "Best note taking apps" },
  { name: "Notion", reason: "recommended as a flexible notes and knowledge base app", sourceTitle: "Best note taking apps" },
  { name: "Obsidian", reason: "recommended for markdown notes and personal knowledge management", sourceTitle: "Best note taking apps" },
  { name: "TherapyNotes", reason: "praised for therapist practice management and patient records", sourceTitle: "Best note taking tool for therapists" }
]);
assert.deepEqual(noteTakingCompatibility.compatibleNames.sort(), ["GoodNotes", "Notion", "Obsidian"].sort(), "Working software note-taking contenders should remain compatible while niche clinical tools need generic note-taking proof");

const crmOpinionCompatibility = filterCompatibleSoftwareSignalsForRegression("is salesforce still the best crm", [
  { name: "Salesforce", reason: "still worth considering as a CRM for lead tracking and follow-ups", sourceTitle: "Best CRM software" },
  { name: "HubSpot", reason: "experts strongly recommend HubSpot as a Salesforce alternative CRM for teams that value adoption", sourceTitle: "HubSpot CRM alternatives" },
  { name: "Shape", reason: "recommended from one community comment as a CRM alternative", sourceTitle: "CRM Recommendation" },
  { name: "Sheetify", reason: "recommended from one community comment as a CRM alternative", sourceTitle: "CRM Recommendation" },
  { name: "RandomApp", reason: "recommended in the same thread", sourceTitle: "CRM Recommendation" }
]);
assert.ok(crmOpinionCompatibility.compatibleNames.includes("Salesforce CRM"), "Salesforce target should remain eligible for CRM opinion queries");
assert.ok(crmOpinionCompatibility.compatibleNames.includes("HubSpot"), "Explicitly scoped CRM/Salesforce alternatives with strong context should remain eligible");
assert.equal(crmOpinionCompatibility.compatibleNames.includes("Shape"), false, "One weak source should not make Shape a leading Salesforce-opinion alternative");
assert.equal(crmOpinionCompatibility.compatibleNames.includes("Sheetify"), false, "One weak source should not make Sheetify a leading Salesforce-opinion alternative");
assert.equal(crmOpinionCompatibility.compatibleNames.includes("RandomApp"), false, "Unrelated software should not survive CRM subtype compatibility");

const crmCategoryCompatibility = filterCompatibleSoftwareSignalsForRegression("best crm software", [
  { name: "HubSpot", reason: "recommended as a CRM for sales pipeline and contact management", sourceTitle: "Best CRM software" },
  { name: "Close", reason: "recommended for fast follow-up loop and sales pipeline work", sourceTitle: "Best CRM software" },
  { name: "GenericDocs", reason: "recommended as a document collaboration app", sourceTitle: "Best CRM software" },
  { name: "Zoho CRM", reason: "mentioned in comparisons but not recommended", sentiment: "neutral", sourceTitle: "Best CRM software" }
]);
assert.ok(crmCategoryCompatibility.compatibleNames.includes("HubSpot"), "CRM-compatible tools should remain eligible");
assert.ok(crmCategoryCompatibility.compatibleNames.includes("Close"), "Unknown legitimate CRM tools should survive when candidate evidence proves CRM fit");
assert.equal(crmCategoryCompatibility.compatibleNames.includes("GenericDocs"), false, "Generic unrelated software should be rejected for CRM queries");
assert.equal(crmCategoryCompatibility.compatibleNames.includes("Zoho CRM"), false, "Neutral-only software contenders should not enter aggregation eligibility");

const projectManagementCompatibility = filterCompatibleSoftwareSignalsForRegression("best project management software", [
  { name: "Trello", reason: "recommended for kanban project management", sourceTitle: "Best project management software" },
  { name: "ONES.com", reason: "recommended as a Jira alternative for project tracking", sourceTitle: "Best project management software" }
]);
assert.deepEqual(projectManagementCompatibility.compatibleNames.sort(), ["ONES.com", "Trello"].sort(), "Project-management software tools should remain eligible");

const emailMarketingCompatibility = filterCompatibleSoftwareSignalsForRegression("best email marketing platform", [
  { name: "Mailchimp", reason: "recommended for email marketing campaigns and newsletters", sourceTitle: "Best email marketing platforms" },
  { name: "Klaviyo", reason: "recommended for ecommerce email marketing automation", sourceTitle: "Best email marketing platforms" },
  { name: "ActiveCampaign", reason: "recommended for email automation and campaign workflows", sourceTitle: "Best email marketing platforms" },
  { name: "Brevo", reason: "recommended for newsletters and email marketing automation", sourceTitle: "Best email marketing platforms" }
]);
assert.deepEqual(
  emailMarketingCompatibility.compatibleNames.sort(),
  ["ActiveCampaign", "Brevo", "Klaviyo", "Mailchimp"].sort(),
  "Legitimate email marketing tools should remain eligible when candidate evidence supports email marketing fit"
);

const unknownSoftwareCompatibility = filterCompatibleSoftwareSignalsForRegression("best email marketing platform", [
  { name: "CampaignForge", reason: "recommended for email marketing campaigns, newsletters, and subscriber automation", sourceTitle: "Best email marketing platforms" }
]);
assert.deepEqual(unknownSoftwareCompatibility.compatibleNames, ["CampaignForge"], "Unknown legitimate software should survive with strong subtype evidence");

console.log(
  JSON.stringify(
    {
      requestedEntityTypeCompatibility: {
        aiCodingCompatibility,
        noteTakingCompatibility,
        crmOpinionCompatibility,
        crmCategoryCompatibility,
        projectManagementCompatibility,
        emailMarketingCompatibility,
        unknownSoftwareCompatibility
      }
    },
    null,
    2
  )
);

const splitTwoContenders = [contender("Antica Pesa", { sourceUrls: ["regression://1"] }), contender("I Cavallini", { sourceUrls: ["regression://2"] })];
const splitTwoResults = enforceDisplayableSplitConsensusInvariant(
  consensusFixture({
    results: splitTwoContenders.map(resultFromContender),
    contenders: splitTwoContenders
  })
);
assert.equal(splitTwoResults.mode, "split_consensus", "Split consensus with 2+ displayable contenders should remain split consensus");
assert.equal(splitTwoResults.results.length, 2, "Split consensus with 2+ displayable contenders should preserve both contenders");

const singleSplitContender = contender("Antica Pesa", { sourceUrls: ["regression://1"] });
const splitOneResult = enforceDisplayableSplitConsensusInvariant(
  consensusFixture({
    results: [resultFromContender(singleSplitContender)],
    contenders: [singleSplitContender]
  })
);
assert.equal(splitOneResult.mode, "no_reliable_consensus", "Split consensus with exactly 1 displayable contender should become no reliable consensus");
assert.deepEqual(splitOneResult.results.map((result) => result.name), ["Antica Pesa"], "One valid surviving contender should remain displayable");
assert.equal(
  selectNoReliableConsensusDisplayContendersForRegression([singleSplitContender]).contenders.length,
  1,
  "No reliable consensus fallback can display the surviving evidence-backed contender"
);

const splitZeroResult = enforceDisplayableSplitConsensusInvariant(consensusFixture({ results: [], contenders: [] }));
assert.equal(splitZeroResult.mode, "no_reliable_consensus", "Split consensus with 0 displayable contenders should become no reliable consensus");
assert.equal(splitZeroResult.results.length, 0, "Zero-result split invariant should not invent contenders");

const cachedSingleSplit = sanitizeCachedLocalConsensus(
  consensusFixture({
    query: "best restaurant in williamsburg",
    results: [resultFromContender(singleSplitContender)],
    contenders: [singleSplitContender],
    signals: [
      {
        sourceUrl: "regression://1",
        sourceTitle: "Regression source",
        domain: "regression",
        sourceType: "editorial",
        sourceWeight: 1,
        sourceQuality: "high",
        sourceQualityWeight: 1,
        contenderName: "Antica Pesa",
        sentiment: "positive",
        mentionStrength: "moderate",
        positiveMention: "Positive attributed evidence.",
        extractedReason: "Regression",
        themes: ["verified business"],
        verifiedAddress: "115 Berry St, Brooklyn, NY 11249, USA",
        placesTypes: ["italian_restaurant"],
        placesCategoryConfidence: 1,
        placesLocationConfidence: 1,
        placesVerified: true
      }
    ]
  })
);
assert.equal(cachedSingleSplit.mode, "no_reliable_consensus", "Cached/sanitized split consensus with 1 result should obey the invariant");
assert.equal(cachedSingleSplit.results.length, 1, "Cached invariant should preserve the valid surviving result");

const evidenceBackedDentist = contender("Gregg Ueckert", { positives: 1, sourceUrls: ["regression://gregg-dentist"], score: 4 });
const cachedSingleDentistNoReliable = sanitizeCachedLocalConsensus(
  consensusFixture({
    query: "best dentist in austin",
    mode: "no_reliable_consensus",
    results: [
      {
        ...resultFromContender(evidenceBackedDentist),
        evidence: ["Gregg Ueckert was positively mentioned in attributed Austin dentist evidence."],
        sources: [
          {
            title: "Austin dentist recommendations",
            url: "regression://gregg-dentist",
            domain: "regression",
            snippet: "Gregg Ueckert is mentioned in Austin dentist recommendations."
          }
        ],
        verifiedAddress: undefined
      }
    ],
    contenders: [evidenceBackedDentist],
    signals: [
      {
        sourceUrl: "regression://gregg-dentist",
        sourceTitle: "Austin dentist recommendations",
        domain: "regression",
        sourceType: "editorial",
        sourceWeight: 1,
        sourceQuality: "high",
        sourceQualityWeight: 1,
        contenderName: "Gregg Ueckert",
        sentiment: "positive",
        mentionStrength: "moderate",
        positiveMention: "Gregg Ueckert was positively mentioned in attributed Austin dentist evidence.",
        extractedReason: "Regression",
        themes: ["dentist recommendation"]
      }
    ]
  })
);
assert.equal(cachedSingleDentistNoReliable.mode, "no_reliable_consensus", "Single evidence-backed dentist should remain no reliable consensus");
assert.deepEqual(
  cachedSingleDentistNoReliable.results.map((result) => result.name),
  ["Gregg Ueckert"],
  "No reliable consensus should still display a valid evidence-backed single local contender"
);

const unsupportedDentist = contender("Unsupported Dentist", { positives: 0, sourceUrls: [], score: 0 });
const cachedUnsupportedDentistNoReliable = sanitizeCachedLocalConsensus(
  consensusFixture({
    query: "best dentist in austin",
    mode: "no_reliable_consensus",
    results: [
      {
        ...resultFromContender(unsupportedDentist),
        evidence: [],
        sources: [],
        verifiedAddress: undefined
      }
    ],
    contenders: [unsupportedDentist],
    signals: []
  })
);
assert.equal(cachedUnsupportedDentistNoReliable.results.length, 0, "Unsupported sparse local contenders should remain hidden");

console.log(
  JSON.stringify(
    {
      splitConsensusDisplayInvariant: {
        twoResultMode: splitTwoResults.mode,
        oneResultMode: splitOneResult.mode,
        oneResultNames: splitOneResult.results.map((result) => result.name),
        zeroResultMode: splitZeroResult.mode,
        cachedOneResultMode: cachedSingleSplit.mode,
        cachedDentistNames: cachedSingleDentistNoReliable.results.map((result) => result.name),
        unsupportedDentistCount: cachedUnsupportedDentistNoReliable.results.length
      }
    },
    null,
    2
  )
);

const italianSubtypeProof = localSubtypeProofForRegression(
  "best italian restaurant in williamsburg",
  "Oregano",
  ["italian_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    verifiedAddress: "102 Berry St, Williamsburg, Brooklyn, NY 11211, USA",
    sourceTitle: "Williamsburg restaurant recommendations",
    sourceSnippet: "Oregano is a frequent local pick."
  }
);
assert.equal(
  italianSubtypeProof.subtypeProof,
  true,
  "Places italian_restaurant type should satisfy Italian subtype proof when positive attributed evidence exists"
);
assert.equal(italianSubtypeProof.discoveryPasses, true, "Italian subtype proof should keep a verified evidence-backed local contender discoverable");

const sushiSubtypeProof = localSubtypeProofForRegression(
  "best sushi in brooklyn",
  "Sushi Katsuei",
  ["sushi_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Brooklyn sushi recommendations",
    sourceSnippet: "Sushi Katsuei appears in local recommendations."
  }
);
assert.equal(sushiSubtypeProof.subtypeProof, true, "Places sushi_restaurant type should satisfy sushi subtype proof");
assert.equal(sushiSubtypeProof.discoveryPasses, true, "Sushi subtype proof should keep a verified evidence-backed local contender discoverable");

const coffeeSubtypeProtection = localSubtypeProofForRegression(
  "best coffee shop in brooklyn",
  "Coffee Check",
  ["coffee_shop", "cafe", "food_store", "store", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Brooklyn coffee shop recommendations",
    sourceSnippet: "Coffee Check appears in local recommendations."
  }
);
assert.equal(coffeeSubtypeProtection.discoveryPasses, true, "Existing coffee shop subtype behavior should remain protected");

const dentistSubtypeProtection = localSubtypeProofForRegression(
  "best dentist in austin",
  "High Point Dentistry",
  ["dentist", "dental_clinic", "health", "point_of_interest", "establishment"],
  {
    verifiedAddress: "2719 E 7th St, Austin, TX 78702, USA",
    sourceTitle: "Austin dentist recommendations",
    sourceSnippet: "High Point Dentistry appears in local recommendations."
  }
);
assert.equal(dentistSubtypeProtection.discoveryPasses, true, "Existing dentist behavior should remain protected");

const longIslandLeakageProtection = localSubtypeProofForRegression(
  "best cocktail bar on long island",
  "The Long Island Bar",
  ["cocktail_bar", "bar", "restaurant", "food", "point_of_interest", "establishment"],
  {
    verifiedAddress: "110 Atlantic Ave, Brooklyn, NY 11201, USA",
    sourceTitle: "NYC cocktail bar recommendations",
    sourceSnippet: "The Long Island Bar appears in Brooklyn cocktail recommendations."
  }
);
assert.equal(longIslandLeakageProtection.discoveryPasses, false, "Long Island local queries should still reject Brooklyn/Long Island City leakage");

const noPositiveEvidenceSubtypeProof = localSubtypeProofForRegression(
  "best italian restaurant in williamsburg",
  "Oregano",
  ["italian_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  { positiveEvidence: false }
);
assert.equal(noPositiveEvidenceSubtypeProof.discoveryPasses, false, "Places subtype verification without positive recommendation evidence should not reach aggregation");

const wrongCuisineSubtypeProof = localSubtypeProofForRegression(
  "best italian restaurant in williamsburg",
  "Sushi Katsuei",
  ["sushi_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Williamsburg restaurant recommendations",
    sourceSnippet: "Sushi Katsuei appears in local recommendations."
  }
);
assert.equal(wrongCuisineSubtypeProof.subtypeProof, false, "Wrong cuisine subtype should not satisfy Italian subtype proof");
assert.equal(wrongCuisineSubtypeProof.discoveryPasses, false, "Wrong cuisine subtype should still be rejected for cuisine-specific local queries");

const italianPizzaCrossLinkFallback = localFallbackEvidenceEligibilityForRegression(
  "best italian restaurant in williamsburg",
  "Fini Pizza",
  ["pizza_restaurant", "pizza_delivery", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceDomain: "novacircle.com",
    sourceTitle: "Patrizia's of Williamsburg",
    sourceSnippet: "Nearby: Fini Pizza Jersey City. Italian restaurant recommendations for Williamsburg.",
    queryVariant: "best italian restaurant in williamsburg"
  }
);
assert.equal(italianPizzaCrossLinkFallback.eligible, false, "Fallback must not create positive evidence for pizza-only cross-link text in an Italian query");
assert.equal(
  italianPizzaCrossLinkFallback.rejectionReason,
  "fallback_source_presence_only",
  "Pizza-only cross-link fallback should be rejected as source presence only"
);

const validItalianFallback = localFallbackEvidenceEligibilityForRegression(
  "best italian restaurant in williamsburg",
  "Oregano",
  ["italian_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Williamsburg Italian restaurant recommendations",
    sourceSnippet: "Oregano is one of the recommended Williamsburg Italian restaurants.",
    queryVariant: "best italian restaurant in williamsburg"
  }
);
assert.equal(validItalianFallback.eligible, true, "Valid Italian fallback candidates with business-specific evidence should remain eligible");

const seafoodSteakhouseFallback = localFallbackEvidenceEligibilityForRegression(
  "best seafood restaurant in miami",
  "Sunny's Steakhouse",
  ["steak_house", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Best seafood restaurants in Miami",
    sourceSnippet: "Also nearby: Sunny's Steakhouse. A Fish Called Avalon and Joe's Stone Crab are seafood favorites.",
    queryVariant: "best seafood restaurant in miami"
  }
);
assert.equal(seafoodSteakhouseFallback.eligible, false, "Fallback must not admit a steak_house candidate into a seafood query from weak presence text");

const validSushiFallback = localFallbackEvidenceEligibilityForRegression(
  "best sushi in brooklyn",
  "Sake Sushi",
  ["sushi_restaurant", "japanese_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Best sushi in Brooklyn",
    sourceSnippet: "Sake Sushi is recommended for sushi and sashimi.",
    queryVariant: "best sushi in brooklyn"
  }
);
assert.equal(validSushiFallback.eligible, true, "Valid sushi fallback should remain eligible");

const validMexicanFallback = localFallbackEvidenceEligibilityForRegression(
  "best mexican restaurant in austin",
  "Taqueria De Diez",
  ["restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Best Mexican food in Austin",
    sourceSnippet: "Taqueria De Diez is recommended for tacos and Mexican food.",
    queryVariant: "best mexican restaurant in austin"
  }
);
assert.equal(validMexicanFallback.eligible, true, "Candidate-specific Mexican fallback context should remain eligible without a Places subtype prior");

const validCoffeeFallback = localFallbackEvidenceEligibilityForRegression(
  "best coffee shop in brooklyn",
  "Gigi's Coffee Shop",
  ["coffee_shop", "cafe", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Best coffee shops in Brooklyn",
    sourceSnippet: "Gigi's Coffee Shop is a recommended coffee shop for breakfast and coffee.",
    queryVariant: "best coffee shop in brooklyn"
  }
);
assert.equal(validCoffeeFallback.eligible, true, "Existing valid coffee fallback behavior should remain intact");

const sparseValidFallback = localFallbackEvidenceEligibilityForRegression(
  "best brunch in brooklyn",
  "Sunday in Brooklyn",
  ["brunch_restaurant", "breakfast_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Brooklyn brunch recommendations",
    sourceSnippet: "Sunday in Brooklyn is recommended for brunch and pancakes.",
    queryVariant: "best brunch in brooklyn"
  }
);
assert.equal(sparseValidFallback.eligible, true, "Sparse local fallback should still recover business-specific positive evidence");

const presenceOnlyFallback = localFallbackEvidenceEligibilityForRegression(
  "best coffee shop in brooklyn",
  "Random Cafe",
  ["coffee_shop", "cafe", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Brooklyn neighborhood page",
    sourceSnippet: "Random Cafe appears in the page footer.",
    queryVariant: "best coffee shop in brooklyn"
  }
);
assert.equal(presenceOnlyFallback.eligible, false, "Places-verified business with name presence only must not receive positive fallback evidence");

const presenceOnlyWrongSubtypeFallback = localFallbackEvidenceEligibilityForRegression(
  "best seafood restaurant in miami",
  "Random Steakhouse",
  ["steak_house", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Miami neighborhood page",
    sourceSnippet: "Random Steakhouse appears in the page footer.",
    queryVariant: "best seafood restaurant in miami"
  }
);
assert.equal(presenceOnlyWrongSubtypeFallback.eligible, false, "Places-verified wrong-subtype name presence must not receive positive fallback evidence");

const dirtyMartiniPresenceOnlyFallback = localFallbackEvidenceEligibilityForRegression(
  "best dirty martini on long island",
  "Cibo Pasta Bar",
  ["bar", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceDomain: "cibopastabar.com",
    sourceTitle: "CIBO Pasta Bar",
    sourceSnippet: "CIBO Pasta Bar offers dinner, reservations, menus, and private events on Long Island.",
    queryVariant: "best dirty martini on long island"
  }
);
assert.equal(
  dirtyMartiniPresenceOnlyFallback.eligible,
  false,
  "Business-name/site presence alone must not create positive dirty-martini recommendation support"
);
assert.equal(
  dirtyMartiniPresenceOnlyFallback.rejectionReason,
  "fallback_source_presence_only",
  "CIBO own-site/category presence should remain eligibility context, not positive recommendation evidence"
);

const dirtyMartiniValidationOnlyProof = localSubtypeProofForRegression(
  "best dirty martini on long island",
  "Cibo Pasta Bar",
  ["bar", "restaurant", "food", "point_of_interest", "establishment"],
  {
    verifiedAddress: "123 Main St, Long Island, NY 11701, USA",
    sourceTitle: "CIBO Pasta Bar",
    sourceSnippet: "CIBO Pasta Bar offers dinner, reservations, menus, and private events.",
    positiveEvidence: false
  }
);
assert.equal(dirtyMartiniValidationOnlyProof.subtypeProof, true, "Places/category validation can still establish cocktail/bar eligibility");
assert.equal(dirtyMartiniValidationOnlyProof.discoveryPasses, false, "Places/category validation alone must not create positive consensus support");

const validDirtyMartiniFallback = localFallbackEvidenceEligibilityForRegression(
  "best dirty martini on long island",
  "Cibo Pasta Bar",
  ["bar", "restaurant", "food", "point_of_interest", "establishment"],
  {
    sourceTitle: "Best dirty martinis on Long Island",
    sourceSnippet: "Cibo Pasta Bar is recommended for a dirty martini and a strong cocktail program.",
    queryVariant: "best dirty martini on long island"
  }
);
assert.equal(validDirtyMartiniFallback.eligible, true, "Dirty-martini fallback should still admit real candidate-specific cocktail recommendation evidence");

const operationalBusinessStatus = localSubtypeProofForRegression(
  "best italian restaurant in williamsburg",
  "Oregano",
  ["italian_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    businessStatus: "OPERATIONAL",
    verifiedAddress: "102 Berry St, Williamsburg, Brooklyn, NY 11211, USA",
    sourceTitle: "Williamsburg restaurant recommendations",
    sourceSnippet: "Oregano is a frequent local pick."
  }
);
assert.equal(operationalBusinessStatus.discoveryPasses, true, "OPERATIONAL businesses should remain eligible when evidence and validation pass");

const missingBusinessStatus = localSubtypeProofForRegression(
  "best italian restaurant in williamsburg",
  "Oregano",
  ["italian_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    verifiedAddress: "102 Berry St, Williamsburg, Brooklyn, NY 11211, USA",
    sourceTitle: "Williamsburg restaurant recommendations",
    sourceSnippet: "Oregano is a frequent local pick."
  }
);
assert.equal(missingBusinessStatus.discoveryPasses, true, "Missing Places business status should preserve existing behavior");

const temporarilyClosedBusinessStatus = localSubtypeProofForRegression(
  "best italian restaurant in williamsburg",
  "Oregano",
  ["italian_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    businessStatus: "CLOSED_TEMPORARILY",
    verifiedAddress: "102 Berry St, Williamsburg, Brooklyn, NY 11211, USA",
    sourceTitle: "Williamsburg restaurant recommendations",
    sourceSnippet: "Oregano is a frequent local pick."
  }
);
assert.equal(temporarilyClosedBusinessStatus.discoveryPasses, false, "CLOSED_TEMPORARILY businesses should be rejected from active recommendations");

const permanentlyClosedBusinessStatus = localSubtypeProofForRegression(
  "best italian restaurant in williamsburg",
  "Oregano",
  ["italian_restaurant", "restaurant", "food", "point_of_interest", "establishment"],
  {
    businessStatus: "CLOSED_PERMANENTLY",
    verifiedAddress: "102 Berry St, Williamsburg, Brooklyn, NY 11211, USA",
    sourceTitle: "Williamsburg restaurant recommendations",
    sourceSnippet: "Oregano is a frequent local pick."
  }
);
assert.equal(permanentlyClosedBusinessStatus.discoveryPasses, false, "CLOSED_PERMANENTLY businesses should be rejected from active recommendations");

const closedContender = contender("Antica Pesa", { sourceUrls: ["regression://closed"] });
const closedRemovedSplit = sanitizeCachedLocalConsensus(
  consensusFixture({
    query: "best restaurant in williamsburg",
    results: [resultFromContender(closedContender)],
    contenders: [closedContender],
    signals: [
      {
        sourceUrl: "regression://closed",
        sourceTitle: "Regression source",
        domain: "regression",
        sourceType: "editorial",
        sourceWeight: 1,
        sourceQuality: "high",
        sourceQualityWeight: 1,
        contenderName: "Antica Pesa",
        sentiment: "positive",
        mentionStrength: "moderate",
        positiveMention: "Positive attributed evidence.",
        extractedReason: "Regression",
        themes: ["verified business"],
        verifiedAddress: "115 Berry St, Brooklyn, NY 11249, USA",
        placesTypes: ["italian_restaurant"],
        placesCategoryConfidence: 1,
        placesLocationConfidence: 1,
        placesVerified: true,
        placesBusinessStatus: "CLOSED_TEMPORARILY"
      }
    ]
  })
);
assert.equal(closedRemovedSplit.mode, "no_reliable_consensus", "Closed-status cleanup should not leave a one-result split consensus");
assert.equal(closedRemovedSplit.results.length, 0, "Closed local businesses should be removed from active recommendation results");

console.log(
  JSON.stringify(
    {
      localSubtypeProofRegression: {
        italianSubtypeProof,
        sushiSubtypeProof,
        coffeeSubtypeProtection,
        dentistSubtypeProtection,
        longIslandLeakageProtection,
        noPositiveEvidenceSubtypeProof,
        wrongCuisineSubtypeProof,
        operationalBusinessStatus,
        missingBusinessStatus,
        temporarilyClosedBusinessStatus,
        permanentlyClosedBusinessStatus,
        closedRemovedSplit: {
          mode: closedRemovedSplit.mode,
          resultCount: closedRemovedSplit.results.length
        }
      }
    },
    null,
    2
  )
);

function sourceFixture(domain, path, title, snippet, queryVariant = "primary") {
  return {
    title,
    url: `https://${domain}/${path}`,
    domain,
    snippet,
    queryVariant,
    canonicalUrl: `https://${domain}/${path}`
  };
}

const waterBottleTimeoutFallback = await buildProductFallbackConsensus("best water bottle brand", [
  sourceFixture(
    "nytimes.com",
    "wirecutter/reviews/best-water-bottle",
    "The 5 Best Water Bottles of 2026 | Reviews by Wirecutter",
    "## Takeya Actives Insulated Water Bottle\nThe Takeya bottle sealed reliably and performed well in long-term testing."
  ),
  sourceFixture(
    "goodhousekeeping.com",
    "home-products/best-water-bottles",
    "4 Best Water Bottles of 2026, Tested & Reviewed",
    "## Yeti Rambler Water Bottle\nBest Overall. The Yeti Rambler performed well in Lab testing."
  ),
  sourceFixture(
    "shopping.yahoo.com",
    "best-water-bottles",
    "The 11 best water bottles of 2026, tested and reviewed",
    "### Best water bottle overall\n#### Hydro Flask Standard Flex Cap, 24 oz.\nTopping our list is the Hydro Flask Insulated Water Bottle."
  ),
  sourceFixture(
    "reddit.com",
    "r/BuyItForLife/best_water_bottle_to_buy",
    "Best water bottle to buy : r/BuyItForLife",
    "I have Stanley, YETI, RTIC, Owala, and off brand bottles. Stanley keeps water cold; YETI is second place."
  )
]);
assert.ok(waterBottleTimeoutFallback, "Uncategorized water bottle timeout fallback should return a consensus payload");
assert.equal(waterBottleTimeoutFallback?.mode, "no_reliable_consensus", "Weak generic product fallback should preserve no reliable consensus mode");
assert.ok((waterBottleTimeoutFallback?.results.length ?? 0) > 0, "Water bottle timeout fallback should display evidence-backed contenders");
assert.ok(waterBottleTimeoutFallback?.results.some((result) => /takeya/i.test(result.name)), "Water bottle timeout fallback should retain Takeya from source evidence");

const malformedWaterBottleTimeoutFallback = await buildProductFallbackConsensus("best water bottle brand", [
  sourceFixture(
    "youtube.com",
    "watch",
    "Best Water Bottles | Consumer Reports",
    "Description\nConsumer Reports tested insulated bottles.\nMost Versatile\n## Hydro Flask Wide Mouth Water Bottle\nHydro Flask performed well."
  ),
  sourceFixture(
    "allrecipes.com",
    "best-insulated-water-bottles",
    "The Best Insulated Water Bottles, Tested by Allrecipes",
    "Most Versatile\n## Takeya Actives Insulated Water Bottle\nTakeya was recommended by testers."
  ),
  sourceFixture(
    "example-review.com",
    "best-water-bottles",
    "Best Water Bottles Tested",
    "Best Overall\n## Yeti Rambler Water Bottle\nYeti performed well in testing."
  )
]);
const malformedWaterBottleNames = malformedWaterBottleTimeoutFallback?.results.map((result) => result.name) ?? [];
assert.ok(malformedWaterBottleTimeoutFallback, "Malformed water bottle timeout fallback should still retain real evidence-backed products");
assert.equal(malformedWaterBottleTimeoutFallback?.mode, "no_reliable_consensus", "Malformed water bottle timeout fallback should not force consensus");
assert.equal(malformedWaterBottleNames.includes("Consumer Reports"), false, "Product fallback should reject publisher/source names as contenders");
assert.equal(malformedWaterBottleNames.includes("Description"), false, "Product fallback should reject metadata headings as contenders");
assert.equal(malformedWaterBottleNames.includes("Most Versatile"), false, "Product fallback should reject award/prose labels as contenders");
assert.ok(malformedWaterBottleNames.some((name) => /hydro flask/i.test(name)), "Product fallback should retain real water bottle product/brand evidence");
assert.ok(malformedWaterBottleNames.some((name) => /takeya/i.test(name)), "Product fallback should retain Takeya evidence");

const uncategorizedTimeoutFallback = await buildProductFallbackConsensus("best reusable lunch box", [
  sourceFixture("example-review.com", "best-lunch-boxes", "Best Lunch Boxes Tested", "## Bentgo Fresh Lunch Box\nBest overall lunch box in testing."),
  sourceFixture("example-kitchen.com", "lunch-box-review", "Reusable Lunch Box Reviews", "## PlanetBox Rover\nA durable stainless lunch box with strong owner reviews."),
  sourceFixture("reddit.com", "r/buyitforlife/lunch_box", "Lunch box recommendations", "I like Bentgo Fresh and PlanetBox Rover for reusable lunch boxes.")
]);
assert.ok(uncategorizedTimeoutFallback, "Uncategorized product timeout fallback should work without a product category prior");
assert.equal(uncategorizedTimeoutFallback?.mode, "no_reliable_consensus");
assert.ok((uncategorizedTimeoutFallback?.results.length ?? 0) > 0, "Uncategorized product timeout fallback should include notable contenders");

const emptyTimeoutFallback = await buildProductFallbackConsensus("best reusable lunch box", [
  sourceFixture("example.com", "guide", "Best Lunch Box Guide", "This article discusses materials, prices, and care but names no specific products."),
  sourceFixture("retailer.example", "sale", "Lunch Box Deals", "Shop online store deals, add to cart, and browse discounts."),
  sourceFixture("example.org", "tips", "How to choose a lunch box", "Consider size, dishwasher safety, insulation, and budget.")
]);
assert.equal(emptyTimeoutFallback, null, "Timeout fallback with zero valid recovered contenders should allow genuinely empty no-consensus fallback");

const hydroFlaskOpinionTimeoutFallback = await buildProductFallbackConsensus("is hydro flask worth it", [
  sourceFixture(
    "example-review.com",
    "hydro-flask-worth-it",
    "Is Hydro Flask Worth It?",
    "## Hydro Flask Standard Flex\nHydro Flask is a durable pick for insulated water bottles."
  ),
  sourceFixture(
    "example-outdoors.com",
    "water-bottle-comparison",
    "Hydro Flask vs other water bottles",
    "## Yeti Rambler Water Bottle\nYeti is another popular bottle, but this review focuses on whether Hydro Flask is worth buying."
  ),
  sourceFixture(
    "example-kitchen.com",
    "bottles-tested",
    "Water Bottles Tested",
    "## S'well Commuter\nS'well and Zojirushi were compared against Hydro Flask."
  )
]);
assert.ok(hydroFlaskOpinionTimeoutFallback, "Product opinion timeout fallback should keep target-scoped evidence");
assert.equal(hydroFlaskOpinionTimeoutFallback?.mode, "no_reliable_consensus", "Product opinion timeout fallback should preserve no reliable consensus mode");
assert.deepEqual(
  hydroFlaskOpinionTimeoutFallback?.results.map((result) => result.name),
  ["Hydro Flask"],
  "Hydro Flask opinion fallback should roll child/model evidence up to Hydro Flask and reject unrelated bottle brands"
);

const awayOpinionTimeoutFallback = await buildProductFallbackConsensus("is away luggage worth it", [
  sourceFixture(
    "example-travel.com",
    "away-luggage-worth-it",
    "Is Away Luggage Worth It?",
    "## Away Bigger Carry-On\nAway's Bigger Carry-On remains the focus of this luggage review."
  ),
  sourceFixture(
    "example-luggage.com",
    "carry-on-comparison",
    "Carry-on luggage compared",
    "## Travelpro Platinum Elite\nTravelpro is compared with Away in this review."
  ),
  sourceFixture(
    "example-packing.com",
    "luggage-tested",
    "Best carry-ons tested",
    "## Monos Carry-On\nMonos appears as another alternative, while the article discusses whether Away is worth it."
  )
]);
assert.ok(awayOpinionTimeoutFallback, "Away opinion timeout fallback should keep target-scoped evidence");
assert.deepEqual(
  awayOpinionTimeoutFallback?.results.map((result) => result.name),
  ["Away"],
  "Away opinion fallback should roll child/model evidence up to Away and reject unrelated luggage brands"
);

const awayOpinionNormalScope = await productOpinionAggregationScopeForRegression("is away luggage worth it", [
  {
    name: "Away Bigger Carry-On",
    reason: "Away's Bigger Carry-On remains the focus of this luggage review.",
    sourceTitle: "Is Away Luggage Worth It?"
  },
  {
    name: "Travelpro Platinum Elite",
    reason: "Travelpro is mentioned as an alternative while the source evaluates whether Away luggage is worth it.",
    sourceTitle: "Away luggage compared"
  },
  {
    name: "Monos Carry-On",
    reason: "Monos appears as another alternative in a discussion centered on Away.",
    sourceTitle: "Carry-ons tested"
  }
]);
assert.deepEqual(
  awayOpinionNormalScope.resultNames,
  ["Away"],
  "Away product opinion normal aggregation should display only the scoped target entity"
);
assert.equal(
  awayOpinionNormalScope.structuredContenderNames.includes("Travelpro"),
  false,
  "Travelpro should not enter aggregation as a primary contender for a scoped Away opinion query"
);
assert.equal(
  awayOpinionNormalScope.structuredContenderNames.includes("Monos"),
  false,
  "Monos should not enter aggregation as a primary contender for a scoped Away opinion query"
);

const hydroFlaskOpinionNormalScope = await productOpinionAggregationScopeForRegression("is hydro flask worth it", [
  {
    name: "Hydro Flask Standard Flex",
    reason: "Hydro Flask Standard Flex is the product being evaluated.",
    sourceTitle: "Is Hydro Flask Worth It?"
  },
  {
    name: "Yeti Rambler Water Bottle",
    reason: "Yeti is mentioned as a competing insulated bottle.",
    sourceTitle: "Hydro Flask comparison"
  },
  {
    name: "Owala FreeSip",
    reason: "Owala appears as another bottle alternative in a Hydro Flask review.",
    sourceTitle: "Water bottles tested"
  }
]);
assert.deepEqual(
  hydroFlaskOpinionNormalScope.resultNames,
  ["Hydro Flask"],
  "Hydro Flask product opinion normal aggregation should remain scoped to Hydro Flask"
);

const awayComparisonScope = await productOpinionAggregationScopeForRegression("is away luggage worth it vs travelpro", [
  {
    name: "Away Bigger Carry-On",
    reason: "Away's Bigger Carry-On is compared directly with Travelpro.",
    sourceTitle: "Away vs Travelpro"
  },
  {
    name: "Travelpro Platinum Elite",
    reason: "Travelpro Platinum Elite is a direct comparison alternative to Away.",
    sourceTitle: "Away vs Travelpro"
  },
  {
    name: "Monos Carry-On",
    reason: "Monos is also included as a luggage comparison point.",
    sourceTitle: "Luggage comparisons"
  }
]);
assert.ok(
  awayComparisonScope.resultNames.includes("Away") && awayComparisonScope.resultNames.includes("Travelpro"),
  "Explicit product comparison queries should not be scoped to only the first mentioned target"
);

const zeroTargetOpinionTimeoutFallback = await buildProductFallbackConsensus("is hydro flask worth it", [
  sourceFixture("example-review.com", "yeti-review", "Yeti Rambler Review", "## Yeti Rambler Water Bottle\nYeti performed well in testing."),
  sourceFixture("example-outdoors.com", "owala-review", "Owala Bottle Review", "## Owala FreeSip\nOwala was popular with testers."),
  sourceFixture("example-kitchen.com", "takeya-review", "Takeya Bottle Review", "## Takeya Actives\nTakeya sealed reliably.")
]);
assert.equal(
  zeroTargetOpinionTimeoutFallback,
  null,
  "Explicit product opinion fallback with zero target evidence should allow an honest empty no-consensus response instead of unrelated products"
);

console.log(
  JSON.stringify(
    {
      productTimeoutFallback: {
        waterBottle: waterBottleTimeoutFallback?.results.map((result) => result.name),
        malformedWaterBottle: malformedWaterBottleNames,
        uncategorized: uncategorizedTimeoutFallback?.results.map((result) => result.name),
        emptyAllowed: emptyTimeoutFallback === null,
        hydroFlaskOpinion: hydroFlaskOpinionTimeoutFallback?.results.map((result) => result.name),
        awayOpinion: awayOpinionTimeoutFallback?.results.map((result) => result.name),
        zeroTargetOpinionEmptyAllowed: zeroTargetOpinionTimeoutFallback === null
      }
    },
    null,
    2
  )
);

const sourceSelectionCases = [
  {
    name: "specialist beats generic listicle",
    query: "Best laptop for college students",
    limit: 3,
    sources: [
      sourceFixture("generic-a.example", "best-laptops", "Top 10 Best Laptops Buying Guide", "Generic affiliate listicle with a broad buying guide and repeated product summaries.", "primary"),
      sourceFixture("generic-b.example", "best-laptops", "15 Best Laptops For Students", "Another generic ranked listicle with similar affiliate-style descriptions and little testing.", "primary"),
      sourceFixture("consumerreports.org", "electronics/laptops", "Survey Results: The Most Reliable Laptops", "Consumer Reports reliability survey with structured laptop evidence and testing context.", "primary"),
      sourceFixture("notebookcheck.net", "college-laptop-tests", "Best Student Laptops Tested", "Specialist laptop publication with benchmark testing and long-term evidence.", "primary")
    ],
    mustRetainDomains: ["consumerreports.org", "notebookcheck.net"],
    expectedCount: 3
  },
  {
    name: "community and editorial diversity",
    query: "Best CRM software",
    limit: 3,
    sources: [
      sourceFixture("generic-crm.example", "list-1", "Best CRM Software List", "Generic CRM software list with repeated vendor summaries.", "expert"),
      sourceFixture("pcmag.com", "crm/reviews", "Best CRM Software Reviews", "Editorial CRM reviews comparing sales pipeline and contact-management products.", "expert"),
      sourceFixture("reddit.com", "r/sales/crm", "CRM recommendations from sales teams", "Community discussion comparing HubSpot, Salesforce, Pipedrive and Zoho CRM.", "community"),
      sourceFixture("generic-crm.example", "list-2", "Top CRM Tools", "Similar CRM listicle from the same generic domain.", "expert")
    ],
    mustRetainDomains: ["pcmag.com", "reddit.com"],
    expectedCount: 3
  },
  {
    name: "multiple results from one domain",
    query: "Best carry on luggage",
    limit: 3,
    sources: [
      sourceFixture("same.example", "a", "Best Carry On Luggage A", "Generic luggage list with similar recommendations.", "primary"),
      sourceFixture("same.example", "b", "Best Carry On Luggage B", "Another generic luggage page from the same domain.", "primary"),
      sourceFixture("same.example", "c", "Best Carry On Luggage C", "Third generic luggage page from same domain.", "primary"),
      sourceFixture("wirecutter.com", "carry-on-luggage", "Best Carry-On Luggage", "Specialist editorial testing for carry-on luggage.", "primary"),
      sourceFixture("reddit.com", "r/travel/luggage", "Carry-on luggage recommendations", "Community travel recommendations for carry-on luggage.", "community")
    ],
    mustRetainDomains: ["wirecutter.com", "reddit.com"],
    expectedCount: 3
  },
  {
    name: "credible retail structured evidence",
    query: "Best laptop",
    limit: 3,
    sources: [
      sourceFixture("generic-laptop.example", "top", "Top 10 Laptop Deals", "Generic deal-oriented buying guide with affiliate descriptions.", "primary"),
      sourceFixture("bestbuy.com", "site/laptops", "Laptop Computers and Reviews", "Structured retail laptop listings with reviews and availability context.", "primary"),
      sourceFixture("nytimes.com", "wirecutter/laptops", "Best Laptops Reviews by Wirecutter", "Independent editorial laptop tests and product evidence.", "primary"),
      sourceFixture("generic-laptop.example", "list", "Best Laptop List", "Repeated generic listicle from same domain.", "primary")
    ],
    mustRetainDomains: ["bestbuy.com", "nytimes.com"],
    expectedCount: 3
  },
  {
    name: "local authority preservation",
    query: "Best pizza on Long Island",
    limit: 3,
    sources: [
      sourceFixture("generic-local.example", "pizza", "Best Pizza List", "Generic local pizza listicle without strong local authority.", "primary"),
      sourceFixture("eater.com", "long-island-pizza", "Best Pizza on Long Island", "Local editorial guide naming Long Island pizzerias and neighborhood context.", "primary"),
      sourceFixture("reddit.com", "r/longisland/pizza", "Best pizza on Long Island discussion", "Community discussion from Long Island locals naming favorite pizzerias.", "community"),
      sourceFixture("yelp.com", "search-pizza-long-island", "Best Pizza near Long Island", "Structured review listing with local ratings and business listings.", "primary")
    ],
    mustRetainDomains: ["eater.com", "reddit.com"],
    expectedCount: 3
  }
];

for (const item of sourceSelectionCases) {
  const result = compareConsensusSourceSelectionForRegression(item.query, item.sources, item.limit);
  assert.equal(result.selected.length, item.expectedCount, `${item.name} should preserve source limit`);

  for (const domain of item.mustRetainDomains) {
    assert.ok(result.selected.some((url) => url.includes(domain)), `${item.name} should retain ${domain}`);
  }

  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.stage === "consensus_source_selection" && diagnostic.retained), `${item.name} should report retained source diagnostics`);

  console.log(JSON.stringify({ sourceSelection: { name: item.name, selected: result.selected, newlyRetained: result.newlyRetained, displaced: result.displaced } }, null, 2));
}

for (const invalid of [
  "Fi",
  "For",
  "Visit This Year",
  "Visit the Design District",
  "Explore the Islands",
  "Discover Rome",
  "Underrated Beaches",
  "the Top Portugal Beaches",
  "Best Islands in Portugal",
  "Visiting Portugal's Islands",
  "What Islands",
  "All-Inclusive Island",
  "Which Caribbean Island",
  "West Coast",
  "Best Caribbean Islands",
  "Our Readers' Favorite Islands",
  "Most the Islands",
  "Seeking CANDID Reviews of Multiple Caribbean Islands",
  "Caribbean Destination Grand Cayman Grenada Caribbean Island",
  "Discover the Best Islands",
  "Jamaica and Pigeon Island"
]) {
  assert.equal(isGenericDestinationContenderName("Best beaches in Portugal for vacation", invalid), true, `${invalid} should be rejected as generic`);
}

assert.equal(isGenericDestinationContenderName("Best all inclusive Caribbean island", "Sugar Beach"), true, "Beach/resort-style names should not satisfy island queries");
assert.equal(acceptedCaribbeanCandidates.includes("Sugar Beach"), false, "Sugar Beach should not be accepted for an island query");

for (const valid of ["Praia da Marinha", "Comporta Beach", "São Miguel Island", "Costa Nova"]) {
  assert.equal(isGenericDestinationContenderName("Best beaches in Portugal for vacation", valid), false, `${valid} should remain a valid destination name`);
}

const broadDestinationExtractionCases = [
  {
    query: "Best neighborhood to stay in Rome",
    text: "The best neighborhoods to stay in Rome include Trastevere, Monti, Prati, and Centro Storico for different trip styles.",
    expected: ["Trastevere", "Monti", "Prati", "Centro Storico"]
  },
  {
    query: "Best islands in Greece",
    text: "Top Greek islands include Naxos, Paros, Santorini, Crete, and Milos for beaches, food, and scenery.",
    expected: ["Naxos", "Paros", "Santorini", "Crete", "Milos"]
  },
  {
    query: "Best ski destinations in Colorado",
    text: "Colorado ski destinations often include Aspen, Vail, Breckenridge, and Telluride.",
    expected: ["Aspen", "Vail", "Breckenridge", "Telluride"]
  }
];

for (const item of broadDestinationExtractionCases) {
  const candidates = extractDestinationCandidatesFromText(item.text)
    .map(canonicalDestinationName)
    .filter((candidate) => destinationCandidateFitsQuery(item.query, candidate, [item.text]));

  for (const expected of item.expected) {
    assert.ok(candidates.includes(expected), `${item.query} should preserve ${expected}`);
  }

  console.log(JSON.stringify({ broadDestinationExtraction: { query: item.query, candidates } }, null, 2));
}

const repeatedContextualCityCases = [
  { query: "best city in italy to visit", city: "Bologna", evidence: "The best cities to visit in Italy include Bologna for food and culture." },
  { query: "best city in spain to visit", city: "Seville", evidence: "The best cities to visit in Spain include Seville for food, history, and atmosphere." },
  { query: "best city in france to visit", city: "Lyon", evidence: "Recommended cities to visit in France include Lyon for food and culture." },
  { query: "best european city to visit", city: "Prague", evidence: "Top European cities to visit include Prague for architecture and value." }
];

for (const item of repeatedContextualCityCases) {
  const proof = destinationCandidateProof(item.query, item.city, [item.evidence]);
  assert.equal(proof.accepted, true, `${item.city} should be accepted as a contextual destination candidate`);
  assert.equal(proof.requiresMultipleSources, true, `${item.city} should still require repeated independent destination evidence`);
  assert.equal(destinationCandidateFitsQuery(item.query, item.city, [item.evidence]), false, `${item.city} should not pass from one contextual source`);
  assert.equal(
    destinationCandidateFitsQuery(item.query, item.city, [item.evidence], { allowRepeatedContextual: true }),
    true,
    `${item.city} should pass after repeated independent contextual evidence is established`
  );
}

console.log(JSON.stringify({ repeatedContextualCityValidation: repeatedContextualCityCases.map((item) => ({ query: item.query, city: item.city })) }, null, 2));

assert.equal(
  destinationCandidateProof("best city to visit in spain", "A Golden City", ["Spain travel guide: a golden city with art and architecture."]).accepted,
  false,
  "Destination city validation should reject indefinite-article prose fragments like A Golden City"
);
assert.equal(
  destinationCandidateProof("best city to visit in spain", "A Golden City", ["Spain travel guide: a golden city with art and architecture."]).reason,
  "title_or_directory_fragment",
  "A Golden City should be rejected at destination shape validation"
);

assert.equal(
  destinationCandidateProof("best city to visit in spain", "Old Town", ["Best cities to visit in Spain include Valencia, Madrid, and a scenic Old Town."]).accepted,
  false,
  "Destination city validation should reject sub-city place fragments like Old Town"
);
assert.equal(
  destinationCandidateProof("best city to visit in spain", "Old Town", ["Best cities to visit in Spain include Valencia, Madrid, and a scenic Old Town."]).reason,
  "wrong_destination_subtype",
  "Old Town should be rejected as the wrong destination subtype for city queries"
);

for (const subCityCandidate of ["Historic Center", "City Centre", "Gothic Quarter", "Museum District"]) {
  assert.equal(
    destinationCandidateProof("best city to visit in spain", subCityCandidate, [
      `${subCityCandidate} is mentioned in a Spain travel guide alongside city recommendations.`
    ]).accepted,
    false,
    `${subCityCandidate} should not satisfy a city-level destination query`
  );
}

for (const validSpanishCityCandidate of ["Barcelona", "Madrid", "Seville", "Granada", "Valencia"]) {
  const proof = destinationCandidateProof("best city to visit in spain", validSpanishCityCandidate, [
    `The best cities to visit in Spain include ${validSpanishCityCandidate} for food, culture, and history.`
  ]);
  assert.equal(proof.accepted, true, `${validSpanishCityCandidate} should remain eligible as a contextual Spanish city candidate`);
  assert.equal(proof.requiresMultipleSources, true, `${validSpanishCityCandidate} should still require repeated contextual evidence`);
}

function destinationSignalFixture(source, contenderName, reason = `${contenderName} is recommended in a Spain city guide.`) {
  return {
    sourceUrl: source.url,
    sourceTitle: source.title,
    domain: source.domain,
    sourceType: "editorial",
    sourceWeight: 1.8,
    sourceQuality: "high",
    sourceQualityWeight: 1,
    queryVariant: source.queryVariant,
    contenderName,
    sentiment: "positive",
    mentionStrength: "moderate",
    positiveMention: reason,
    extractedReason: reason,
    themes: ["destination recommendation"]
  };
}

const bonTravelerValencia = sourceFixture(
  "bontraveler.com",
  "best-cities-spain",
  "15 Best Beautiful Cities in Spain to Visit",
  "A visit to Valencia is a chance to try famous paella in a thriving food city."
);
const rickStevesValencia = sourceFixture(
  "community.ricksteves.com",
  "travel-forum/spain-reviews/spain-what-cities-are-a-must",
  "Spain what cities are a must",
  "Recommended cities to visit in Spain include Valencia for food, culture, and a different pace from Madrid."
);
const openAIValenciaSignal = destinationSignalFixture(
  bonTravelerValencia,
  "Valencia",
  "Valencia is a thriving food city in a best cities in Spain guide."
);
const crossPathValenciaRecovery = recoverDestinationSignalsForRegression(
  "best city to visit in spain",
  [bonTravelerValencia, rickStevesValencia],
  [openAIValenciaSignal]
);
assert.deepEqual(
  crossPathValenciaRecovery.map((signal) => signal.contenderName),
  ["Valencia"],
  "One OpenAI Valencia source plus one independent deterministic Valencia source should satisfy repeated-contextual recovery"
);
assert.deepEqual(
  new Set([openAIValenciaSignal.sourceUrl, ...crossPathValenciaRecovery.map((signal) => signal.sourceUrl)]).size,
  2,
  "Cross-path destination support should come from two independent source URLs"
);

const duplicateUrlValenciaRecovery = recoverDestinationSignalsForRegression(
  "best city to visit in spain",
  [bonTravelerValencia],
  [openAIValenciaSignal]
);
assert.equal(duplicateUrlValenciaRecovery.length, 0, "The same URL detected by both OpenAI and recovery must not count twice");
assert.equal(
  recoverDestinationSignalsForRegression("best city to visit in spain", [rickStevesValencia], []).length,
  0,
  "One deterministic recovery source alone should remain insufficient for repeated-contextual city proof"
);
assert.equal(
  recoverDestinationSignalsForRegression("best city to visit in spain", [bonTravelerValencia], [openAIValenciaSignal]).length,
  0,
  "One OpenAI source alone should remain insufficient when no independent recovery source supports the city"
);
assert.equal(
  recoverDestinationSignalsForRegression(
    "best city to visit in spain",
    [
      sourceFixture(
        "example.com",
        "spain-page",
        "Spain travel notes",
        "Valencia appears in a navigation footer with no city recommendation context."
      )
    ],
    [openAIValenciaSignal]
  ).length,
  0,
  "Weak/plain destination name presence should not combine into repeated-contextual proof"
);

const spanishCityRecoveryContenders = destinationContendersFromSources("best city to visit in spain", [
  {
    title: "Best Cities to Visit in Spain",
    url: "regression://spain-cities-1",
    sourceQuality: 1.4,
    snippet: "Spain favorites include Barcelona, Madrid, Seville, and Old Town. A golden city awaits travelers in every region."
  },
  {
    title: "Spain city guide",
    url: "regression://spain-cities-2",
    sourceQuality: 1.4,
    snippet: "Recommended cities to visit in Spain include Barcelona, Madrid, Granada, and Valencia. A golden city is how one writer described the trip."
  }
]);
const spanishCityRecoveryNames = spanishCityRecoveryContenders.map((item) => item.name);
assert.equal(spanishCityRecoveryNames.includes("A Golden City"), false, "Destination recovery should not retain A Golden City as a city contender");
assert.equal(spanishCityRecoveryNames.includes("Old Town"), false, "Destination recovery should not retain Old Town as a city contender");
assert.ok(spanishCityRecoveryNames.includes("Barcelona"), "Destination recovery should preserve Barcelona for Spain city queries");
assert.ok(spanishCityRecoveryNames.includes("Madrid"), "Destination recovery should preserve Madrid for Spain city queries");

assert.equal(
  destinationCandidateProof("best neighborhood to stay in rome", "Trastevere", ["Trastevere is recommended as a Rome neighborhood for visitors."]).accepted,
  true,
  "Legitimate non-city destination queries should still accept neighborhood contenders"
);

for (const invalidCityCandidate of ["Amalfi Coast", "Tuscany", "Lake Como", "Sicily"]) {
  assert.equal(
    destinationCandidateProof("best city to visit in italy", invalidCityCandidate, ["Best cities to visit in Italy include historic towns, capitals, and coastal destinations."]).accepted,
    false,
    `${invalidCityCandidate} should not satisfy city destination subtype proof from source-wide city words`
  );
}

for (const validCityCandidate of ["Rome", "Florence", "Venice", "Milan", "Naples", "Bologna"]) {
  const proof = destinationCandidateProof("best city to visit in italy", validCityCandidate, [
    `The best cities to visit in Italy include ${validCityCandidate} for food, culture, and history.`
  ]);
  assert.equal(proof.accepted, true, `${validCityCandidate} should remain eligible as a contextual city candidate`);
  assert.equal(proof.requiresMultipleSources, true, `${validCityCandidate} should still require repeated contextual evidence`);
}

for (const invalidIslandCandidate of [
  "Our Readers' Favorite Islands",
  "Most the Islands",
  "Seeking CANDID Reviews of Multiple Caribbean Islands",
  "Caribbean",
  "Caribbean Islands",
  "Non-Touristy Island",
  "Spa the Most Beautiful Islands",
  "Spa Jicaro Island",
  "Caribbean Destination Grand Cayman Grenada Caribbean Island"
]) {
  assert.equal(
    destinationCandidateProof("best caribbean island", invalidIslandCandidate, ["Best Caribbean island travel guide recommendations."]).accepted,
    false,
    `${invalidIslandCandidate} should not satisfy island destination validation`
  );
}

for (const validIslandCandidate of ["Aruba", "Antigua", "St. Lucia", "Jamaica", "Bahamas", "Turks and Caicos"]) {
  assert.equal(
    destinationCandidateProof("best caribbean island", validIslandCandidate, [`${validIslandCandidate} is recommended as a Caribbean island destination.`]).accepted,
    true,
    `${validIslandCandidate} should remain a valid Caribbean island candidate`
  );
  assert.equal(
    destinationCandidateProof("best island in the caribbean for couples", validIslandCandidate, [`${validIslandCandidate} is recommended as a Caribbean island for couples.`]).accepted,
    true,
    `${validIslandCandidate} should not be rejected by Caribbean geography aliases`
  );
}

assert.equal(canonicalDestinationName("St Lucia"), "St. Lucia", "St Lucia alias normalization should be preserved");

const unfamiliarDestinationProof = destinationCandidateProof("best places to visit in europe", "Luminara", [
  "This travel guide recommends Luminara as a quiet European destination for a slow vacation."
]);
assert.equal(unfamiliarDestinationProof.accepted, true, "Valid unfamiliar destination names should not be rejected merely for being unknown");
assert.equal(unfamiliarDestinationProof.requiresMultipleSources, true, "Unfamiliar plain destinations should still require repeated contextual evidence");

const cachedDestinationFixture = consensusFixture({
  query: "best caribbean island",
  mode: "split_consensus",
  results: [
    resultFromContender(contender("Aruba", { positives: 2, sourceUrls: ["regression://aruba-1", "regression://aruba-2"], score: 8 })),
    resultFromContender(contender("Our Readers' Favorite Islands", { positives: 1, sourceUrls: ["regression://bad-title"], score: 5 }), 1)
  ],
  contenders: [
    contender("Aruba", { positives: 2, sourceUrls: ["regression://aruba-1", "regression://aruba-2"], score: 8 }),
    contender("Our Readers' Favorite Islands", { positives: 1, sourceUrls: ["regression://bad-title"], score: 5 })
  ],
  signals: [
    {
      contenderName: "Aruba",
      sourceUrl: "regression://aruba-1",
      sourceTitle: "Best Caribbean island guide",
      domain: "regression",
      sourceType: "editorial",
      sourceWeight: 2,
      sourceQuality: "high",
      sourceQualityWeight: 1,
      sentiment: "positive",
      mentionStrength: "moderate",
      positiveMention: "Aruba is recommended as a Caribbean island.",
      themes: ["destination recommendation"]
    },
    {
      contenderName: "Our Readers' Favorite Islands",
      sourceUrl: "regression://bad-title",
      sourceTitle: "Our Readers' Favorite Islands in the Caribbean",
      domain: "regression",
      sourceType: "editorial",
      sourceWeight: 2,
      sourceQuality: "high",
      sourceQualityWeight: 1,
      sentiment: "positive",
      mentionStrength: "moderate",
      positiveMention: "Article title fragment.",
      themes: ["destination recommendation"]
    }
  ]
});
cachedDestinationFixture.structuredConsensus.queryEvidenceType = "destination_recommendation";
const sanitizedCachedDestination = sanitizeCachedLocalConsensus(cachedDestinationFixture);
assert.deepEqual(
  sanitizedCachedDestination.results.map((result) => result.name),
  ["Aruba"],
  "Cached destination results should reject malformed contender shapes"
);
assert.deepEqual(
  sanitizedCachedDestination.structuredConsensus?.contenders.map((contender) => contender.name),
  ["Aruba"],
  "Cached destination structured consensus should reject malformed contender shapes"
);

const noReliableRecurringDisplay = selectNoReliableConsensusDisplayContendersForRegression([
  contender("Rome", { positives: 2, sourceUrls: ["regression://rome-1", "regression://rome-2"], score: 7 }),
  contender("Florence", { positives: 2, sourceUrls: ["regression://florence-1", "regression://florence-2"], score: 6 }),
  contender("Weak Negative", { positives: 1, negatives: 2, sourceUrls: ["regression://negative"], score: -1 })
]);
assert.equal(noReliableRecurringDisplay.kind, "recurring");
assert.deepEqual(noReliableRecurringDisplay.contenders.map((item) => item.name), ["Rome", "Florence"]);

const noReliableFallbackDisplay = selectNoReliableConsensusDisplayContendersForRegression([
  contender("Bologna", { positives: 1, sourceUrls: ["regression://bologna"], score: 4 }),
  contender("Milan", { positives: 1, sourceUrls: ["regression://milan"], score: 3 }),
  contender("No Source", { positives: 1, sourceUrls: [], score: 3 })
]);
assert.equal(noReliableFallbackDisplay.kind, "fallback");
assert.deepEqual(noReliableFallbackDisplay.contenders.map((item) => item.name), ["Bologna", "Milan"]);

const noReliableEmptyDisplay = selectNoReliableConsensusDisplayContendersForRegression([
  contender("Unsupported", { positives: 0, sourceUrls: ["regression://unsupported"], score: 0 }),
  contender("Net Negative", { positives: 1, negatives: 2, sourceUrls: ["regression://negative"], score: -1 })
]);
assert.equal(noReliableEmptyDisplay.kind, "empty");
assert.equal(noReliableEmptyDisplay.contenders.length, 0);

console.log(
  JSON.stringify(
    {
      noReliablePresentationFallback: {
        recurring: noReliableRecurringDisplay.contenders.map((item) => item.name),
        fallback: noReliableFallbackDisplay.contenders.map((item) => item.name),
        emptyCount: noReliableEmptyDisplay.contenders.length
      }
    },
    null,
    2
  )
);

const proseCityCandidates = extractDestinationCandidatesFromText(
  "The 20 Best Cities to Visit in Italy. Conde Nast Traveller magazine named Bologna as the best food city in the world. ## 1. Verona, one of the best places in Italy for romantics."
).map(canonicalDestinationName);
assert.ok(proseCityCandidates.includes("Bologna"), "Destination prose extraction should include Bologna from named-city recommendation context");
assert.ok(proseCityCandidates.includes("Verona"), "Destination prose extraction should include Verona from numbered city heading context");
assert.equal(
  destinationCandidateProof("best city in italy to visit", "Anguilla", ["Travel + Leisure homepage recommendations"]).reason,
  "explicit_geography_mismatch",
  "Known destinations outside the explicit query geography should be rejected"
);
for (const invalidCityCandidate of ["Picasso Museum", "Luberon Island", "York Brooklyn Porto Dubai Bahrain Cape Town", "Restonica Valley", "Book Now Powered By", "Rome Are Some of the Eternal City"]) {
  assert.equal(
    destinationCandidateProof("best city in france to visit", invalidCityCandidate, ["Best cities to visit in France travel guide recommendations."]).accepted,
    false,
    `City destination validation should reject malformed or non-city contender: ${invalidCityCandidate}`
  );
}

const productionCaribbeanSources = [
  {
    title: "Caribbean All-Inclusive Resorts 2026 Guide By Caribbean Journey",
    url: "https://caribbeanjourney.com/all-inclusive-resorts",
    sourceQuality: 1.35,
    snippet:
      "Jamaica, the Dominican Republic, St. Lucia, and Antigua are among the most popular Caribbean destinations for all-inclusive vacations because they can support larger resort properties."
  },
  {
    title: "The Travelers Guide to All Inclusive Resorts in The Caribbean",
    url: "https://www.theexcellencecollection.com/blog/the-travelers-guide-to-all-inclusive-resorts-in-the-caribbean",
    sourceQuality: 1.2,
    snippet: "The best destination for your All Inclusive escape. Punta Cana, the Dominican Republic."
  },
  {
    title: "THE 10 BEST All Inclusive Resorts in The Caribbean",
    url: "https://www.tripadvisor.com/HotelsList-Caribbean-All-Inclusive-Resorts-zfp746393.html",
    sourceQuality: 1,
    snippet: "Aruba is the quintessential Caribbean island, all sun and sea and stretches of powdery white sand."
  },
  {
    title: "Looking for best first Caribbean island to go to : r/travel",
    url: "https://www.reddit.com/r/travel/comments/1499usj/looking_for_best_first_caribbean_island_to_go_to",
    sourceQuality: 1,
    snippet: "Bahamas, St. Lucia, Grenada, Jamaica and Turks and Caicos. Negril in Jamaica and Pigeon Island in St. Lucia are awesome too."
  },
  {
    title: "Best Caribbean Islands To Travel 2026 4K",
    url: "https://www.youtube.com/watch?v=P5lWBhSl23Y",
    sourceQuality: 0.85,
    snippet: "Best Caribbean Islands travel ideas include Jamaica, St Maarten, St Thomas, Aruba, Dominican Republic and much more."
  },
  {
    title: "How to Choose the Right All-Inclusive Resort Destination | ShermansTravel",
    url: "https://www.shermanstravel.com/advice/all-inclusive-resort-destination-guide-mexico-caribbean",
    sourceQuality: 1.2,
    snippet: "Divers and snorkelers especially love Aruba. Turks and Caicos is another all-inclusive destination, and the Dominican Republic has a large concentration of resorts."
  },
  {
    title: "Caribbean Travel Guide - Expert Picks for your Vacation | Fodor’s Travel",
    url: "https://www.fodors.com/world/caribbean",
    sourceQuality: 1.35,
    snippet:
      "Top destination guides include Aruba, St. Thomas, St. Martin and St. Maarten, Bermuda, Cayman Islands, Turks and Caicos Islands, Punta Cana, St. John, Barbados, Curaçao, St. Kitts."
  },
  {
    title: "Which Caribbean island?? Planning to book soon : r/travel",
    url: "https://www.reddit.com/r/travel/comments/1cl39yh/which_caribbean_island_planning_to_book_soon",
    sourceQuality: 1,
    snippet: "Anguilla, the best island in the Caribbean for beaches, clear water and cuisine was left off. Aruba, which is a great choice. Bahamas are okay."
  }
];

const productionCaribbeanContenders = destinationContendersFromSources("Best all inclusive Caribbean island", productionCaribbeanSources);
const productionCaribbeanByName = Object.fromEntries(
  productionCaribbeanContenders.map((item) => [item.name, { sourceCount: item.sourceCount, positiveMentionCount: item.positiveMentionCount, sourceUrls: item.sourceUrls }])
);
const productionCaribbeanClassification = classifyRegressionCase({
  query: "Best all inclusive Caribbean island",
  evidenceType: "destination_recommendation",
  contenders: productionCaribbeanContenders,
  sourceCount: productionCaribbeanSources.length
});

assert.equal(productionCaribbeanClassification.mode, "split_consensus", "Full-source Caribbean recovery should support split consensus");

for (const expected of ["Aruba", "Dominican Republic", "Jamaica", "St. Lucia", "Turks and Caicos"]) {
  assert.ok(productionCaribbeanByName[expected]?.sourceCount >= 2, `${expected} should accumulate multi-source support`);
}

for (const invalid of ["Fi", "For", "Visit This Year", "What Islands", "All-Inclusive Island", "Which Caribbean Island", "West Coast", "Best Caribbean Islands", "Discover the Best Islands", "Jamaica and Pigeon Island"]) {
  assert.equal(Boolean(productionCaribbeanByName[invalid]), false, `${invalid} should not survive full-source destination recovery`);
}

const singleSourceUnknown = destinationContendersFromSources("Best places to visit in Europe", [
  {
    title: "A travel forum answer",
    url: "single-unknown",
    sourceQuality: 1.2,
    snippet: "This travel guide recommends Luminara for a quiet vacation."
  }
]);
assert.equal(singleSourceUnknown.some((item) => item.name === "Luminara"), false, "One-source unknown proper nouns should not be recovered");

const repeatedSameSourceContenders = destinationContendersFromSources("Best all inclusive Caribbean island", [
  {
    title: "Aruba travel guide",
    url: "same-source",
    sourceQuality: 1.35,
    snippet: "Aruba is popular. Aruba is sunny. Aruba has resorts."
  }
]);
assert.equal(repeatedSameSourceContenders.find((item) => item.name === "Aruba")?.sourceCount, 1, "Repeated destination mentions within one URL should count once");

console.log(
  JSON.stringify(
    {
      productionCaribbeanFullSourceRecovery: {
        mode: productionCaribbeanClassification.mode,
        contenders: productionCaribbeanContenders.map((item) => ({
          name: item.name,
          sourceCount: item.sourceCount,
          positiveMentionCount: item.positiveMentionCount,
          sourceUrls: item.sourceUrls
        }))
      }
    },
    null,
    2
  )
);

console.log(
  JSON.stringify(
    {
      destinationExtraction: {
        caribbeanCandidates,
        acceptedCaribbeanCandidates,
        genericPhrasesRejected: ["Underrated Beaches", "the Top Portugal Beaches", "Best Islands in Portugal", "Visiting Portugal's Islands"]
      }
    },
    null,
    2
  )
);

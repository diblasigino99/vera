import assert from "node:assert/strict";
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
  filterCompatibleEntityNamesForRegression,
  preserveEvidenceBackedProductContendersForRegression,
  resolveEntityNamesForRegression,
  selectNoReliableConsensusDisplayContendersForRegression
} = jiti("./lib/server/analyze.ts");
const { compareConsensusSourceSelectionForRegression } = jiti("./lib/server/search.ts");
const { inferQueryEvidenceType } = jiti("./lib/utils.ts");

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

const aiCodingCompatibility = filterCompatibleEntityNamesForRegression("best ai coding assistant", "software_tool", ["Honda Pilot", "Claude Code", "Cursor"]);
assert.equal(aiCodingCompatibility.compatibleNames.includes("Honda Pilot"), false, "Software queries should reject clear vehicle entities");
assert.ok(aiCodingCompatibility.compatibleNames.includes("Claude Code"), "Software queries should retain software/tool entities");
assert.ok(aiCodingCompatibility.compatibleNames.includes("Cursor"), "Software queries should retain software/tool entities");
assert.ok(
  aiCodingCompatibility.diagnostics.some((diagnostic) => diagnostic.originalName === "Honda Pilot" && diagnostic.validator === "requested_entity_type_compatibility"),
  "Software compatibility rejection should produce diagnostics"
);

const noteTakingCompatibility = filterCompatibleEntityNamesForRegression("best note taking app", "software_tool", ["GoodNotes", "Notion", "Obsidian"]);
assert.deepEqual(noteTakingCompatibility.compatibleNames.sort(), ["GoodNotes", "Notion", "Obsidian"].sort(), "Working software app contenders should remain compatible");

console.log(JSON.stringify({ requestedEntityTypeCompatibility: { aiCodingCompatibility, noteTakingCompatibility } }, null, 2));

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
  "Underrated Beaches",
  "the Top Portugal Beaches",
  "Best Islands in Portugal",
  "Visiting Portugal's Islands",
  "What Islands",
  "All-Inclusive Island",
  "Which Caribbean Island",
  "West Coast",
  "Best Caribbean Islands",
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

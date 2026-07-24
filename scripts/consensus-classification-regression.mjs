import assert from "node:assert/strict";
import { diagnoseMultiContenderSplitEvidence } from "../lib/server/consensus-classification.ts";
import { canonicalDestinationName, destinationCandidateFitsQuery, extractDestinationCandidatesFromText, isGenericDestinationContenderName } from "../lib/server/destination-rules.ts";

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

  for (const source of sources) {
    const text = `${source.title}. ${source.snippet}`;

    for (const rawCandidate of extractDestinationCandidatesFromText(text)) {
      const name = canonicalDestinationName(rawCandidate);

      if (!destinationCandidateFitsQuery(query, name, [source.title, source.snippet])) {
        continue;
      }

      bySourceAndName.set(`${source.url}::${name.toLowerCase()}`, {
        name,
        sourceUrl: source.url,
        sourceQuality: source.sourceQuality ?? 1.2
      });
    }
  }

  const byName = new Map();

  for (const signal of bySourceAndName.values()) {
    const existing = byName.get(signal.name) ?? {
      name: signal.name,
      sourceUrls: [],
      quality: 0,
      positives: 0,
      score: 0
    };

    existing.sourceUrls.push(signal.sourceUrl);
    existing.quality += signal.sourceQuality;
    existing.positives += 1;
    existing.score += signal.sourceQuality * 4;
    byName.set(signal.name, existing);
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
const acceptedCaribbeanCandidates = caribbeanCandidates.filter((candidate) => !isGenericDestinationContenderName("Best all inclusive Caribbean island", candidate));

for (const expected of ["St. Lucia", "Jamaica", "Antigua", "Anguilla", "Aruba", "Grand Cayman", "Bahamas"]) {
  assert.ok(caribbeanCandidates.includes(expected), `Expected destination extraction to include ${expected}`);
}

for (const invalid of ["Underrated Beaches", "the Top Portugal Beaches", "Best Islands in Portugal", "Visiting Portugal's Islands"]) {
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
    query: "Best places to visit in Italy",
    text: "Many Italy travel guides recommend Rome, Florence, Venice, Naples, and the Amalfi Coast for first-time visitors.",
    expected: ["Rome", "Florence", "Venice", "Naples", "Amalfi Coast"]
  },
  {
    query: "Best ski destinations in Colorado",
    text: "Colorado ski destinations often include Aspen, Vail, Breckenridge, Telluride, and Steamboat Springs.",
    expected: ["Aspen", "Vail", "Breckenridge", "Telluride", "Steamboat Springs"]
  }
];

for (const item of broadDestinationExtractionCases) {
  const candidates = extractDestinationCandidatesFromText(item.text)
    .map(canonicalDestinationName)
    .filter((candidate) => destinationCandidateFitsQuery(item.query, candidate, [item.text]));

  for (const expected of item.expected) {
    assert.ok(candidates.includes(expected), `${item.query} should extract ${expected}`);
  }

  console.log(
    JSON.stringify(
      {
        broadDestinationExtraction: {
          query: item.query,
          candidates
        }
      },
      null,
      2
    )
  );
}

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
  productionCaribbeanContenders.map((item) => [
    item.name,
    {
      sourceCount: item.sourceCount,
      sourceUrls: item.sourceUrls,
      positiveMentionCount: item.positiveMentionCount
    }
  ])
);
const productionCaribbeanClassification = classifyRegressionCase({
  query: "Best all inclusive Caribbean island",
  evidenceType: "destination_recommendation",
  contenders: productionCaribbeanContenders,
  sourceCount: productionCaribbeanSources.length
});

assert.equal(productionCaribbeanClassification.mode, "split_consensus", "Full-source Caribbean destination recovery should support split consensus");
assert.equal(productionCaribbeanClassification.diagnostics?.supported, true, "Full-source Caribbean contenders should pass multi-contender diagnostics");

for (const expected of ["Aruba", "Dominican Republic", "Jamaica", "St. Lucia", "Turks and Caicos"]) {
  assert.ok(productionCaribbeanByName[expected]?.sourceCount >= 2, `${expected} should accumulate multi-source support from full sources`);
}

for (const invalid of [
  "What Islands",
  "All-Inclusive Island",
  "Which Caribbean Island",
  "West Coast",
  "Best Caribbean Islands",
  "Discover the Best Islands",
  "Jamaica and Pigeon Island",
  "Caribbean",
  "Caribbean All-",
  "Expert Picks",
  "Looking",
  "Planning",
  "St. Martin and St.",
  "Aruba. Turks and Caicos",
  "the Caribbean. Aruba",
  "Dominican Republic and"
]) {
  assert.equal(isGenericDestinationContenderName("Best all inclusive Caribbean island", invalid), true, `${invalid} should be rejected as a destination fragment`);
  assert.equal(Boolean(productionCaribbeanByName[invalid]), false, `${invalid} should not survive full-source destination recovery`);
}

const repeatedSameSourceContenders = destinationContendersFromSources("Best all inclusive Caribbean island", [
  {
    title: "Aruba travel guide",
    url: "same-source",
    sourceQuality: 1.35,
    snippet: "Aruba is popular. Aruba is sunny. Aruba has resorts."
  }
]);
assert.equal(repeatedSameSourceContenders.find((item) => item.name === "Aruba")?.sourceCount, 1, "Repeated destination mentions within one source should count as one source");

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
        })),
        diagnostics: productionCaribbeanClassification.diagnostics
      }
    },
    null,
    2
  )
);

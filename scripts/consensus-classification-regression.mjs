import assert from "node:assert/strict";
import { diagnoseMultiContenderSplitEvidence } from "../lib/server/consensus-classification.ts";
import { canonicalDestinationName, extractDestinationCandidatesFromText, isGenericDestinationContenderName } from "../lib/server/destination-rules.ts";

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

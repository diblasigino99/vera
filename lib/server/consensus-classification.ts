import type { ContenderMetrics } from "@/lib/types";
import type { QueryEvidenceType } from "@/lib/utils";

const minimumTotalPositiveMentions = 3;

export type MultiContenderSplitDiagnostics = {
  supported: boolean;
  evidenceTypeAllowed: boolean;
  broadExploratoryProductBlocked: boolean;
  contenderCount: number;
  totalPositiveMentions: number;
  positiveSourceCount: number;
  positiveMentionFloorPassed: boolean;
  positiveSourceFloorPassed: boolean;
  credibleContenders: Array<{
    name: string;
    positiveMentionCount: number;
    negativeMentionCount: number;
    sourceCount: number;
    sourceQualityScore: number;
    netWeightedScore: number;
    sourceUrls: string[];
  }>;
  credibleContenderFloorPassed: boolean;
  supportedSourceUrls: string[];
  strongerContenderCount: number;
  combinedTopScore: number;
  finalConditionsPassed: boolean;
};

export function diagnoseMultiContenderSplitEvidence(
  contenders: ContenderMetrics[],
  evidenceType: QueryEvidenceType,
  options: { isBroadExploratoryProductQuery?: boolean } = {}
): MultiContenderSplitDiagnostics {
  const totalPositiveMentions = contenders.reduce((total, contender) => total + contender.positiveMentionCount, 0);
  const positiveSourceCount = new Set(contenders.flatMap((contender) => (contender.positiveMentionCount > 0 ? contender.sourceUrls : []))).size;
  const evidenceTypeAllowed =
    evidenceType === "destination_recommendation" ||
    evidenceType === "provider_or_brand_recommendation" ||
    evidenceType === "product_recommendation" ||
    evidenceType === "software_tool";
  const broadExploratoryProductBlocked = evidenceType === "product_recommendation" && Boolean(options.isBroadExploratoryProductQuery);
  const positiveMentionFloorPassed = totalPositiveMentions >= minimumTotalPositiveMentions;
  const positiveSourceFloorPassed = positiveSourceCount >= 2;
  const credibleContenders = contenders
    .slice(0, 5)
    .filter(
      (contender) =>
        contender.positiveMentionCount > 0 &&
        contender.netWeightedScore >= 6 &&
        contender.sourceQualityScore >= 2.4 &&
        contender.negativeMentionCount <= contender.positiveMentionCount
    )
    .map((contender) => ({
      name: contender.name,
      positiveMentionCount: contender.positiveMentionCount,
      negativeMentionCount: contender.negativeMentionCount,
      sourceCount: contender.sourceCount,
      sourceQualityScore: contender.sourceQualityScore,
      netWeightedScore: contender.netWeightedScore,
      sourceUrls: contender.sourceUrls
    }));
  const supportedSourceUrls = Array.from(new Set(credibleContenders.flatMap((contender) => contender.sourceUrls)));
  const strongerContenderCount = credibleContenders.filter(
    (contender) => contender.positiveMentionCount >= 2 || contender.sourceCount >= 2 || contender.netWeightedScore >= 10
  ).length;
  const combinedTopScore = credibleContenders.slice(0, 3).reduce((total, contender) => total + contender.netWeightedScore, 0);
  const finalConditionsPassed = supportedSourceUrls.length >= 2 && strongerContenderCount >= 1 && combinedTopScore >= 18;
  const supported =
    evidenceTypeAllowed &&
    !broadExploratoryProductBlocked &&
    contenders.length >= 2 &&
    positiveMentionFloorPassed &&
    positiveSourceFloorPassed &&
    credibleContenders.length >= 2 &&
    finalConditionsPassed;

  return {
    supported,
    evidenceTypeAllowed,
    broadExploratoryProductBlocked,
    contenderCount: contenders.length,
    totalPositiveMentions,
    positiveSourceCount,
    positiveMentionFloorPassed,
    positiveSourceFloorPassed,
    credibleContenders,
    credibleContenderFloorPassed: credibleContenders.length >= 2,
    supportedSourceUrls,
    strongerContenderCount,
    combinedTopScore,
    finalConditionsPassed
  };
}

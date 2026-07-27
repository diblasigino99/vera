import { NO_RELIABLE_CONSENSUS_BODY } from "@/lib/types";
import type { ConsensusResponse } from "@/lib/types";

type ConsensusMode = ConsensusResponse["mode"];

export function confidenceExplanationForMode(mode: ConsensusMode) {
  switch (mode) {
    case "clear_consensus":
      return "Clear because independent sources repeatedly favored the same option while alternatives received far less support.";
    case "strong_consensus":
      return "Strong because several independent sources favored the same option, with limited disagreement.";
    case "moderate_consensus":
      return "Moderate because one option led the available evidence, while credible alternatives still appeared.";
    case "split_consensus":
      return "Split because credible sources consistently supported more than one option.";
    case "no_reliable_consensus":
      return NO_RELIABLE_CONSENSUS_BODY;
  }
}

export function resultGeneratedLabel(result: Pick<ConsensusResponse, "generated_at" | "createdAt">) {
  const timestamp = result.generated_at ?? result.createdAt;

  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `Result generated ${new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date)}`;
}

export function editorializeTrustCopy(text: string) {
  return text
    .replace(/\brecommendation signals\b/gi, "recurring recommendations")
    .replace(/\brecommendation signal\b/gi, "recurring recommendation")
    .replace(/\bweighted source signal\b/gi, "pattern of independent support")
    .replace(/\bstored source signal\b/gi, "stored evidence")
    .replace(/\bsource diversity\b/gi, "breadth of sources")
    .replace(/\bcontender gap\b/gi, "lead over alternatives")
    .replace(/\bgap between contenders\b/gi, "lead over alternatives")
    .replace(/\bconsensus score\b/gi, "consensus support")
    .replace(/\branking signal\b/gi, "evidence pattern")
    .replace(/\bpositive mentions\b/gi, "supporting recommendations")
    .replace(/\bpositive mention\b/gi, "supporting recommendation")
    .replace(/\bcurrent signal\b/gi, "current evidence");
}

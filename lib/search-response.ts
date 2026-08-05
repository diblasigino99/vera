import type { ConsensusResponse, FactualAnswerResponse, SearchResponse, VeraSource } from "@/lib/types";

export function isFactualAnswerResponse(result: SearchResponse | null | undefined): result is FactualAnswerResponse {
  if (!result || typeof result !== "object") {
    return false;
  }

  if ("type" in result && result.type === "factual_answer") {
    return true;
  }

  return !("mode" in result) && "answer" in result && typeof result.answer === "string";
}

export function isConsensusResponse(result: SearchResponse | null | undefined): result is ConsensusResponse {
  if (!result || typeof result !== "object" || isFactualAnswerResponse(result)) {
    return false;
  }

  return "mode" in result && Array.isArray(result.results) && Array.isArray(result.sources);
}

export function responseRenderBranchForRegression(result: SearchResponse | null | undefined) {
  if (isFactualAnswerResponse(result)) return "factual_answer";
  if (isConsensusResponse(result)) return "consensus";
  return "empty";
}

export function responseSources(result: Pick<FactualAnswerResponse, "sources"> | Pick<ConsensusResponse, "sources">): VeraSource[] {
  return Array.isArray(result.sources) ? result.sources : [];
}

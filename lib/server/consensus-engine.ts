import type { QueryEvidenceType, QueryIntent } from "@/lib/utils";
import { canonicalizeQuery, inferQueryEvidenceType, inferQueryIntent, normalizeQuery } from "@/lib/utils";

export type DiscardReason = {
  stage: string;
  code: string;
  message?: string;
  contenderName?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
};

export type StageResult<TOutput = unknown> = {
  stage: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  output?: TOutput;
  error?: string;
  discards?: DiscardReason[];
};

export type ConsensusTask = {
  id: string;
  query: string;
  normalizedQuery: string;
  canonicalQuery: string;
  evidenceType: QueryEvidenceType;
  queryIntent: QueryIntent;
  actorId?: string;
  createdAt: string;
};

export type ConsensusTrace = {
  id: string;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  stages: StageResult[];
  discards: DiscardReason[];
};

export type RunConsensusEngineOptions<TResult> = {
  actorId?: string;
  execute: (context: { task: ConsensusTask; trace: ConsensusTrace }) => Promise<TResult>;
};

export async function runConsensusEngine<TResult>(query: string, options: RunConsensusEngineOptions<TResult>): Promise<TResult> {
  const task = buildConsensusTask(query, options.actorId);
  const trace = buildConsensusTrace(task);
  const startedAt = Date.now();
  const routeStage: StageResult = {
    stage: "existing_route_pipeline",
    status: "running",
    startedAt: new Date(startedAt).toISOString()
  };

  trace.stages.push(routeStage);

  try {
    const result = await options.execute({ task, trace });
    const completedAt = Date.now();
    routeStage.status = "completed";
    routeStage.completedAt = new Date(completedAt).toISOString();
    routeStage.durationMs = completedAt - startedAt;
    trace.completedAt = routeStage.completedAt;
    return result;
  } catch (error) {
    const completedAt = Date.now();
    routeStage.status = "failed";
    routeStage.completedAt = new Date(completedAt).toISOString();
    routeStage.durationMs = completedAt - startedAt;
    routeStage.error = error instanceof Error ? error.message : String(error);
    trace.completedAt = routeStage.completedAt;
    throw error;
  }
}

function buildConsensusTask(query: string, actorId?: string): ConsensusTask {
  return {
    id: crypto.randomUUID(),
    query,
    normalizedQuery: normalizeQuery(query),
    canonicalQuery: canonicalizeQuery(query),
    evidenceType: inferQueryEvidenceType(query),
    queryIntent: inferQueryIntent(query),
    actorId,
    createdAt: new Date().toISOString()
  };
}

function buildConsensusTrace(task: ConsensusTask): ConsensusTrace {
  return {
    id: crypto.randomUUID(),
    taskId: task.id,
    startedAt: task.createdAt,
    stages: [],
    discards: []
  };
}

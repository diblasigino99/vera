export type ExternalCallCounts = {
  supabaseReads: number;
  tavilyCalls: number;
  openAiCalls: number;
  supabaseWrites: number;
  tavilyCallReasons: Array<{
    evidenceType: string;
    queryVariant: string;
    phase: string;
  }>;
  openAiCallReasons: Array<{
    evidenceType: string;
    phase: string;
  }>;
};

export function createExternalCallCounts(): ExternalCallCounts {
  return {
    supabaseReads: 0,
    tavilyCalls: 0,
    openAiCalls: 0,
    supabaseWrites: 0,
    tavilyCallReasons: [],
    openAiCallReasons: []
  };
}

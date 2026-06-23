export type ExternalCallCounts = {
  supabaseReads: number;
  tavilyCalls: number;
  openAiCalls: number;
  supabaseWrites: number;
};

export function createExternalCallCounts(): ExternalCallCounts {
  return {
    supabaseReads: 0,
    tavilyCalls: 0,
    openAiCalls: 0,
    supabaseWrites: 0
  };
}

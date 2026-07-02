export type ExternalCallCounts = {
  supabaseReads: number;
  tavilyCalls: number;
  openAiCalls: number;
  placesApiCalls: number;
  placesCacheHits: number;
  placesValidationAttempts: number;
  placesValidationsSucceeded: number;
  placesValidationsRejected: number;
  finalVerifiedPlacesContenders: string[];
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
    placesApiCalls: 0,
    placesCacheHits: 0,
    placesValidationAttempts: 0,
    placesValidationsSucceeded: 0,
    placesValidationsRejected: 0,
    finalVerifiedPlacesContenders: [],
    supabaseWrites: 0,
    tavilyCallReasons: [],
    openAiCallReasons: []
  };
}

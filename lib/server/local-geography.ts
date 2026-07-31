import { normalizeLocalQueryIntent, normalizeQuery, parseLocalIntent } from "@/lib/utils";

export type LocalGeographyContainmentResult = {
  requestedRegion: string | null;
  status: "inside" | "outside" | "unknown";
  matchedTerm?: string;
  outsideTerm?: string;
};

type LocalRegionDefinition = {
  key: string;
  requestPatterns: RegExp[];
  insideTerms: string[];
  insideZipPatterns?: RegExp[];
  outsideTerms: string[];
};

const localRegionDefinitions: LocalRegionDefinition[] = [
  {
    key: "nassau_county",
    requestPatterns: [/\bnassau county\b/, /\bnassau\b/],
    insideTerms: [
      "nassau",
      "nassau county",
      "garden city",
      "westbury",
      "roslyn",
      "mineola",
      "massapequa",
      "massapequa park",
      "franklin square",
      "elmont",
      "syosset",
      "hicksville",
      "hempstead",
      "west hempstead",
      "north hempstead",
      "east meadow",
      "carle place",
      "rockville centre",
      "levittown",
      "wantagh",
      "seaford",
      "farmingdale",
      "bellmore",
      "north bellmore",
      "merrick",
      "manhasset",
      "great neck",
      "jericho",
      "floral park",
      "albertson",
      "woodbury",
      "point lookout"
    ],
    insideZipPatterns: [/^110\d{2}$/, /^115\d{2}$/, /^118\d{2}$/],
    outsideTerms: [
      "suffolk county",
      "suffolk",
      "huntington",
      "smithtown",
      "bay shore",
      "patchogue",
      "yaphank",
      "centereach",
      "brooklyn",
      "queens",
      "long island city",
      "lic",
      "manhattan",
      "bronx",
      "staten island",
      "new york city",
      "nyc"
    ]
  },
  {
    key: "westchester_county",
    requestPatterns: [/\bwestchester county\b/, /\bwestchester\b/],
    insideTerms: [
      "westchester",
      "westchester county",
      "scarsdale",
      "mamaroneck",
      "hastings on hudson",
      "hastings-on-hudson",
      "irvington",
      "armonk",
      "pound ridge",
      "sleepy hollow",
      "white plains",
      "yonkers",
      "tarrytown",
      "rye",
      "new rochelle",
      "larchmont",
      "dobbs ferry",
      "pleasantville",
      "chappaqua",
      "mount kisco",
      "ossining"
    ],
    insideZipPatterns: [/^105\d{2}$/, /^106\d{2}$/, /^107\d{2}$/, /^108\d{2}$/],
    outsideTerms: ["brooklyn", "queens", "long island city", "lic", "manhattan", "bronx", "staten island", "long island", "nassau", "suffolk"]
  },
  {
    key: "long_island",
    requestPatterns: [/\blong island\b/],
    insideTerms: [
      "long island",
      "nassau",
      "nassau county",
      "suffolk",
      "suffolk county",
      "huntington",
      "massapequa",
      "wantagh",
      "garden city",
      "mineola",
      "rockville centre",
      "syosset",
      "jericho",
      "farmingdale",
      "bay shore",
      "patchogue",
      "smithtown",
      "manhasset",
      "amityville",
      "yaphank"
    ],
    insideZipPatterns: [/^110\d{2}$/, /^115\d{2}$/, /^117\d{2}$/, /^118\d{2}$/, /^119\d{2}$/],
    outsideTerms: ["long island city", "lic", "queens", "astoria", "flushing", "jackson heights", "brooklyn", "manhattan", "bronx", "staten island", "new york city", "nyc"]
  },
  {
    key: "queens",
    requestPatterns: [/\bqueens\b/],
    insideTerms: [
      "queens",
      "astoria",
      "long island city",
      "lic",
      "flushing",
      "forest hills",
      "sunnyside",
      "jackson heights",
      "bayside",
      "ridgewood",
      "elmhurst",
      "woodside",
      "jamaica",
      "kew gardens",
      "rego park",
      "whitestone",
      "corona"
    ],
    outsideTerms: ["manhattan", "brooklyn", "nolita", "bowery", "williamsburg", "greenpoint", "lower east side", "soho", "tribeca", "chelsea", "west village", "east village"]
  },
  {
    key: "brooklyn",
    requestPatterns: [/\bbrooklyn\b/],
    insideTerms: ["brooklyn", "williamsburg", "greenpoint", "bushwick", "park slope", "fort greene", "dumbo", "bed stuy", "crown heights", "carroll gardens"],
    outsideTerms: ["manhattan", "queens", "long island city", "lic", "nolita", "bowery", "lower east side", "soho", "tribeca", "chelsea", "west village", "east village"]
  }
];

export function localGeographyContainment(queryOrLocation: string, verifiedAddress?: string | null): LocalGeographyContainmentResult {
  const requested = normalizeQuery(localRequestedGeographyLabel(queryOrLocation));
  const address = normalizeQuery(verifiedAddress ?? "");
  const region = localRegionDefinitions.find((definition) => definition.requestPatterns.some((pattern) => pattern.test(requested)));

  if (!region || !address) {
    return {
      requestedRegion: region?.key ?? null,
      status: "unknown"
    };
  }

  const outsideTerm = region.outsideTerms.find((term) => address.includes(normalizeQuery(term)));

  if (outsideTerm) {
    return {
      requestedRegion: region.key,
      status: "outside",
      outsideTerm
    };
  }

  const matchedTerm = region.insideTerms.find((term) => address.includes(normalizeQuery(term)));

  if (matchedTerm) {
    return {
      requestedRegion: region.key,
      status: "inside",
      matchedTerm
    };
  }

  const zip = address.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
  const zipMatches = Boolean(zip && region.insideZipPatterns?.some((pattern) => pattern.test(zip)));

  if (zipMatches) {
    return {
      requestedRegion: region.key,
      status: "inside",
      matchedTerm: zip
    };
  }

  return {
    requestedRegion: region.key,
    status: "unknown"
  };
}

export function localRegionLocationTerms(queryOrLocation: string) {
  const requested = normalizeQuery(localRequestedGeographyLabel(queryOrLocation));
  const region = localRegionDefinitions.find((definition) => definition.requestPatterns.some((pattern) => pattern.test(requested)));

  return region ? Array.from(new Set(region.insideTerms.map(normalizeQuery))) : [];
}

function localRequestedGeographyLabel(queryOrLocation: string) {
  const parsedIntent = parseLocalIntent(queryOrLocation);

  if (parsedIntent.locationForSearch) return parsedIntent.locationForSearch;

  return normalizeLocalQueryIntent(queryOrLocation);
}

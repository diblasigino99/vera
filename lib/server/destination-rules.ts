const standaloneDestinationNames = [
  "Anguilla",
  "Antigua",
  "Aruba",
  "Bahamas",
  "Barbados",
  "Belize",
  "Bermuda",
  "Cayman Islands",
  "Curacao",
  "Curaçao",
  "Dominican Republic",
  "Grenada",
  "Grand Cayman",
  "Jamaica",
  "Puerto Rico",
  "Punta Cana",
  "Roatan",
  "Saint Lucia",
  "Saint Martin",
  "Saint Kitts and Nevis",
  "St. Lucia",
  "St. John",
  "St. Johns",
  "St. Kitts and Nevis",
  "St. Martin",
  "Sint Maarten",
  "Turks and Caicos",
  "USVI"
] as const;

export function extractDestinationCandidatesFromText(text: string) {
  const normalizedText = text.replace(/[“”]/g, '"').replace(/[’]/g, "'");
  const candidates = new Set<string>();
  const suffixPattern =
    /\b((?:St\.?\s+|Saint\s+|Fort\s+)?[A-Z][A-Za-z'.-]*(?:\s+(?:and|of|the|de|del|la|le|du|[A-Z][A-Za-z'.-]*)){0,5}\s+(?:Beach|Beaches|Island|Islands|Park|Parks|Preserve|Trail|Trails|Falls|Valley|Village|Town|City|Neighborhood|Neighbourhood|District|Quarter|Region|Mountains|Mountain|Lake|Springs|Key|Keys|Point|Pier|Bay|Harbor|Harbour|Coast|Shore|Shores|Cove|Caves|Canyon|Gardens|Market|Museum|Monument))\b/g;
  const fortPattern = /\b(Fort\s+[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3})\b/g;

  for (const match of normalizedText.matchAll(suffixPattern)) {
    candidates.add(match[1]);
  }

  for (const match of normalizedText.matchAll(fortPattern)) {
    candidates.add(match[1]);
  }

  for (const destination of standaloneDestinationNames) {
    const pattern = new RegExp(`\\b${escapeRegex(destination)}\\b`, "i");
    if (pattern.test(normalizedText)) {
      candidates.add(destination);
    }
  }

  return Array.from(candidates)
    .map((candidate) => candidate.replace(/^[#*\d.\s-]+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function canonicalDestinationName(name: string) {
  const compact = name.replace(/\s+/g, " ").trim();
  const normalized = normalizeDestinationText(compact.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

  if (/^(?:sao miguel|sao miguel island|miguel island)$/.test(normalized)) {
    return "São Miguel Island";
  }

  if (/^(?:the )?(?:(?:portugal(?:['’]?s|\s+s)) |portuguese )?azores(?: islands?)?$/.test(normalized)) {
    return "Azores";
  }

  if (/^(?:saint lucia|st lucia)$/.test(normalized)) return "St. Lucia";
  if (/^(?:curacao)$/.test(normalized)) return "Curaçao";

  const titled = compact
    .split(" ")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "st" || lower === "st.") return "St.";
      if (lower === "de") return "De";
      if (lower === "of" || lower === "the" || lower === "and") return lower;
      if (lower === "usvi") return "USVI";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");

  return titled.replace(/\bSt\. Pete\b/, "St. Pete").replace(/\bDe Soto\b/, "De Soto");
}

export function isGenericDestinationContenderName(query: string, name: string) {
  const normalized = normalizeDestinationText(name.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const querySubject = normalizeDestinationText(query)
    .replace(/\b(best|top|recommended|great|good|where to|places? to|things to|visit|stay|from|near|around|in|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length < 2) return true;
  if (normalized === querySubject) return true;
  if (/\bislands?\b/.test(normalizeDestinationText(query)) && !/\bbeach(?:es)?\b/.test(normalizeDestinationText(query)) && /\bbeach(?:es)?\b/.test(normalized)) {
    return true;
  }
  if (
    /^(?:beach|beaches|neighborhood|neighborhoods|neighbourhood|neighbourhoods|island|islands|weekend trips?|day trips?|destinations?|places?|places to visit|things to do|where to stay|areas? to stay|travel guide|guide|tourism|tripadvisor|reddit|booking|hotels?|best beaches|best islands|best neighborhoods?)$/.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /\b(?:where to stay|things to do|places to visit|best beaches|best islands|best neighborhoods|travel guide|itinerary|guide to|top \d+|best \d+)\b/.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /^(?:the\s+)?(?:best|top|underrated|hidden|secret|beautiful|amazing|favorite|favourite|must visit|essential)\b/.test(normalized) &&
    /\b(?:islands?|beaches|neighborhoods?|neighbourhoods?|destinations?|places?|spots?|regions?|towns?)\b/.test(normalized)
  ) {
    return true;
  }
  if (
    /^(?:visiting|exploring|discovering|guide to|where to|how to)\b/.test(normalized) &&
    /\b(?:islands?|beaches|neighborhoods?|neighbourhoods?|destinations?|places?|regions?|towns?)\b/.test(normalized)
  ) {
    return true;
  }
  if (/\b(?:reddit|tripadvisor|booking|expedia|conde nast|travel leisure|time out|timeout|official tourism|tourism board)\b/.test(normalized)) {
    return true;
  }
  if (/[:|]/.test(name) && normalized.split(/\s+/).length >= 4) return true;

  return false;
}

function normalizeDestinationText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s'&.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

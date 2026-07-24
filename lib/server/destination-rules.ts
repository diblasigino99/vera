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
  const properNounPattern =
    /\b((?:The\s+)?(?:[A-Z][a-zÀ-ÖØ-öø-ÿ'.-]+|St\.|USVI)(?:\s+(?:and|of|the|de|del|la|le|du|[A-Z][a-zÀ-ÖØ-öø-ÿ'.-]+|St\.)){0,3})\b/g;
  const listContextPattern =
    /\b(?:include|includes|included|including|recommend|recommends|recommended|features?|featured|such as|like)\s+([^.;:!?]{3,180})/gi;

  for (const match of normalizedText.matchAll(suffixPattern)) {
    candidates.add(match[1]);
  }

  for (const match of normalizedText.matchAll(fortPattern)) {
    candidates.add(match[1]);
  }

  for (const match of normalizedText.matchAll(listContextPattern)) {
    for (const candidate of extractCandidatesFromDestinationList(match[1])) {
      candidates.add(candidate);
    }
  }

  for (const match of normalizedText.matchAll(properNounPattern)) {
    const candidate = match[1];
    const before = normalizedText.slice(Math.max(0, match.index - 90), match.index);
    const after = normalizedText.slice((match.index ?? 0) + candidate.length, (match.index ?? 0) + candidate.length + 90);

    if (hasPlainDestinationContext(before, after)) {
      candidates.add(candidate);
    }
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
    .slice(0, 30);
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
  if (/^turks and caicos(?: islands?)?$/.test(normalized)) return "Turks and Caicos";
  if (/^st maarten$/.test(normalized)) return "Sint Maarten";
  if (/^st thomas$/.test(normalized)) return "St. Thomas";

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
  const queryText = normalizeDestinationText(query);
  const querySubject = normalizeDestinationText(query)
    .replace(/\b(best|top|recommended|great|good|where to|places? to|things to|visit|stay|from|near|around|in|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length < 2) return true;
  if (normalized === querySubject) return true;
  if (queryText.includes(normalized) && destinationTypeFromQuery(queryText) !== "destination") {
    return true;
  }
  if (queryText.includes(` in ${normalized}`) || queryText.includes(` from ${normalized}`) || queryText.includes(` near ${normalized}`) || queryText.endsWith(` ${normalized}`)) {
    return true;
  }
  if (/\.\s*\w/.test(name.replace(/\bSt\./g, "St"))) return true;
  if (/(?:^|\s)(?:and|or|the|st\.?|saint)$/.test(normalized)) return true;
  if (/(?:^|\s)(?:all-?|all\s*)$/.test(normalized)) return true;
  if (/\b(?:all\s+inclusive|all-inclusive|resorts?|hotels?|lodging|where to stay)\b/.test(normalized) && destinationTypeFromQuery(queryText) !== "ski") {
    return true;
  }
  if (/\b(?:journey|collection|guide|travel|vacation packages?|message board|forum|thread|comments?)\b/.test(normalized) && normalized.split(/\s+/).length >= 2) {
    return true;
  }
  if (/\b(?:expert picks?|editors? picks?|readers? choice|go list|top destinations?|destination guides?)\b/.test(normalized)) {
    return true;
  }
  if (/^(?:best|top|recommended|popular)\s+[a-z]+(?:\s+[a-z]+)?$/.test(normalized)) {
    return true;
  }
  if (normalized.split(/\s+/).length === 1 && /^(?:best|top|guide|travel|vacation|resort|resorts|hotel|hotels|image|read|more|courtesy|source|destination|destinations|looking|planning|how|which|what|expert|picks?|maarten)$/.test(normalized)) {
    return true;
  }
  if (/^(?:what|which)\s+(?:caribbean\s+)?islands?\b/.test(normalized)) return true;
  if (/^(?:what|which)\s+[a-z]+$/.test(normalized)) return true;
  if (/^(?:all\s+inclusive|all-inclusive)\s+islands?\b/.test(normalized)) return true;
  if (/^(?:caribbean|portugal|greek|italian|european)\s+islands?$/.test(normalized) && normalizeDestinationText(query).includes(normalized.replace(/\s+islands?$/, ""))) {
    return true;
  }
  if (/^(?:east|west|north|south)(?:ern)?\s+(?:coast|side|shore)\b/.test(normalized)) return true;
  if (
    /\band\b/.test(normalized) &&
    /\bislands?\b/.test(normalized) &&
    !/^(?:saint|st\.?)\s+kitts\s+and\s+nevis$/.test(normalized) &&
    !/^turks\s+and\s+caicos(?:\s+islands?)?$/.test(normalized) &&
    !/^(?:st\.?\s+martin|saint\s+martin)\s+and\s+(?:st\.?\s+maarten|sint\s+maarten)$/.test(normalized)
  ) {
    return true;
  }
  if (/\bislands?\b/.test(normalizeDestinationText(query)) && !/\bbeach(?:es)?\b/.test(normalizeDestinationText(query)) && /\bbeach(?:es)?\b/.test(normalized)) {
    return true;
  }
  if (destinationTypeFromQuery(queryText) === "island" && /\b(?:resort|hotel|harbor|harbour|park|gardens|museum|market|monument|mountain|peak|trail|falls|cove|bay|beach|beaches|bluff)\b/.test(normalized)) {
    return true;
  }
  if (destinationTypeFromQuery(queryText) === "beach" && /\b(?:hotel|resort|restaurant|bar|shop|market|museum|monument|neighborhood|neighbourhood)\b/.test(normalized)) {
    return true;
  }
  if (destinationTypeFromQuery(queryText) === "neighborhood" && /\b(?:hotel|resort|beach|island|park|museum|market|monument|restaurant|bar)\b/.test(normalized)) {
    return true;
  }
  if (destinationTypeFromQuery(queryText) === "ski" && /\b(?:hotel|restaurant|bar|shop|museum|market|beach|island)\b/.test(normalized)) {
    return true;
  }
  if (/^(?:the\s+)?(?:right|best|top|first|next|perfect|ideal)\s+(?:all\s+inclusive|all-inclusive|destination|island|beach|neighborhood|neighbourhood|trip|place)\b/.test(normalized)) {
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

export function destinationCandidateFitsQuery(query: string, name: string, evidenceTexts: string[] = []) {
  if (isGenericDestinationContenderName(query, name)) return false;

  const normalizedName = normalizeDestinationText(name);
  const queryType = destinationTypeFromQuery(normalizeDestinationText(query));
  const evidence = normalizeDestinationText(evidenceTexts.join(" "));

  if (queryType === "beach") {
    return /\b(?:beach|beaches|praia|coast|shore|cove|bay|sands?|seaside|waterfront)\b/.test(normalizedName) || /\b(?:beach|beaches|praia|coast|shore|cove|bay|seaside|waterfront)\b/.test(evidence);
  }

  if (queryType === "neighborhood") {
    return (
      /\b(?:neighborhood|neighbourhood|district|quarter|village|area)\b/.test(normalizedName) ||
      /\b(?:where to stay|neighborhood|neighbourhood|district|quarter|area to stay|areas to stay|base yourself|stay in)\b/.test(evidence)
    );
  }

  if (queryType === "ski") {
    return /\b(?:ski|skiing|snowboard|mountain|resort|village|town)\b/.test(normalizedName) || /\b(?:ski|skiing|snowboard|mountain|resort|powder|slopes?)\b/.test(evidence);
  }

  return true;
}

function hasPlainDestinationContext(before: string, after: string) {
  const context = normalizeDestinationText(`${before} ${after}`);

  return /\b(?:include|includes|included|including|like|such as|among|visit|go to|stay in|destination|destinations|island|islands|beach|beaches|neighborhood|neighbourhood|town|towns|city|cities|region|regions|trip|trips|guide|vacation|honeymoon|ski)\b/.test(
    context
  );
}

function extractCandidatesFromDestinationList(value: string) {
  return value
    .split(",")
    .flatMap((part) => part.split(/\s+and\s+(?=(?:the\s+)?[A-Z])/))
    .map((part) =>
      part
        .replace(/^\s*(?:and|or|the)\s+/i, "")
        .replace(/\s+\b(?:for|because|with|when|where|while|that|which|to|as)\b.*$/i, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((candidate) => isDestinationListCandidate(candidate));
}

function isDestinationListCandidate(value: string) {
  if (!value || value.length < 2) return false;
  if (value.length > 60) return false;
  if (/^(?:food|scenery|culture|history|beaches|resorts?|hotels?|destinations?|places?|areas?|travelers?|visitors?|families|couples)$/i.test(value)) return false;

  return /^(?:The\s+)?(?:[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+|St\.|USVI)(?:\s+(?:and|of|the|de|del|la|le|du|[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+|St\.)){0,4}$/.test(value);
}

function destinationTypeFromQuery(query: string) {
  if (/\b(?:island|islands)\b/.test(query) && !/\b(?:beach|beaches)\b/.test(query)) return "island";
  if (/\b(?:beach|beaches)\b/.test(query)) return "beach";
  if (/\b(?:neighborhood|neighborhoods|neighbourhood|neighbourhoods|where to stay|area to stay|areas to stay)\b/.test(query)) return "neighborhood";
  if (/\b(?:ski|skiing|snowboard|snowboarding)\b/.test(query)) return "ski";
  return "destination";
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

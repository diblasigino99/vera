type DestinationKind = "island" | "beach" | "neighborhood" | "ski" | "destination";
type DestinationProofPath = "known_destination" | "strong_geographic_form" | "repeated_contextual";

type KnownDestination = {
  canonical: string;
  aliases: string[];
  kinds: DestinationKind[];
};

const knownDestinations = [
  { canonical: "Anguilla", aliases: ["Anguilla"], kinds: ["island", "destination"] },
  { canonical: "Antigua", aliases: ["Antigua"], kinds: ["island", "destination"] },
  { canonical: "Aruba", aliases: ["Aruba"], kinds: ["island", "destination"] },
  { canonical: "Bahamas", aliases: ["Bahamas", "Exuma Bahamas"], kinds: ["island", "destination"] },
  { canonical: "Barbados", aliases: ["Barbados"], kinds: ["island", "destination"] },
  { canonical: "Belize", aliases: ["Belize"], kinds: ["destination"] },
  { canonical: "Bermuda", aliases: ["Bermuda"], kinds: ["island", "destination"] },
  { canonical: "Cayman Islands", aliases: ["Cayman Islands"], kinds: ["island", "destination"] },
  { canonical: "Curaçao", aliases: ["Curacao", "Curaçao"], kinds: ["island", "destination"] },
  { canonical: "Dominican Republic", aliases: ["Dominican Republic", "the Dominican Republic"], kinds: ["island", "destination"] },
  { canonical: "Grenada", aliases: ["Grenada"], kinds: ["island", "destination"] },
  { canonical: "Grand Cayman", aliases: ["Grand Cayman"], kinds: ["island", "destination"] },
  { canonical: "Jamaica", aliases: ["Jamaica"], kinds: ["island", "destination"] },
  { canonical: "Puerto Rico", aliases: ["Puerto Rico"], kinds: ["island", "destination"] },
  { canonical: "Punta Cana", aliases: ["Punta Cana"], kinds: ["island", "destination"] },
  { canonical: "Roatan", aliases: ["Roatan", "Roatán"], kinds: ["island", "destination"] },
  { canonical: "St. Lucia", aliases: ["Saint Lucia", "St. Lucia", "St Lucia"], kinds: ["island", "destination"] },
  { canonical: "Saint Martin", aliases: ["Saint Martin", "St. Martin", "St Martin"], kinds: ["island", "destination"] },
  { canonical: "Sint Maarten", aliases: ["Sint Maarten", "St. Maarten", "St Maarten"], kinds: ["island", "destination"] },
  { canonical: "St. John", aliases: ["St. John", "St John", "St. Johns", "St Johns"], kinds: ["island", "destination"] },
  { canonical: "St. Kitts and Nevis", aliases: ["Saint Kitts and Nevis", "St. Kitts and Nevis", "St Kitts and Nevis"], kinds: ["island", "destination"] },
  { canonical: "St. Thomas", aliases: ["St. Thomas", "St Thomas"], kinds: ["island", "destination"] },
  { canonical: "Turks and Caicos", aliases: ["Turks and Caicos", "Turks and Caicos Islands"], kinds: ["island", "destination"] },
  { canonical: "USVI", aliases: ["USVI", "U.S. Virgin Islands", "United States Virgin Islands"], kinds: ["island", "destination"] },
  { canonical: "Trastevere", aliases: ["Trastevere"], kinds: ["neighborhood", "destination"] },
  { canonical: "Monti", aliases: ["Monti"], kinds: ["neighborhood", "destination"] },
  { canonical: "Prati", aliases: ["Prati"], kinds: ["neighborhood", "destination"] },
  { canonical: "Centro Storico", aliases: ["Centro Storico"], kinds: ["neighborhood", "destination"] },
  { canonical: "Naxos", aliases: ["Naxos"], kinds: ["island", "destination"] },
  { canonical: "Paros", aliases: ["Paros"], kinds: ["island", "destination"] },
  { canonical: "Santorini", aliases: ["Santorini"], kinds: ["island", "destination"] },
  { canonical: "Crete", aliases: ["Crete"], kinds: ["island", "destination"] },
  { canonical: "Milos", aliases: ["Milos"], kinds: ["island", "destination"] },
  { canonical: "Aspen", aliases: ["Aspen"], kinds: ["ski", "destination"] },
  { canonical: "Vail", aliases: ["Vail"], kinds: ["ski", "destination"] },
  { canonical: "Breckenridge", aliases: ["Breckenridge"], kinds: ["ski", "destination"] },
  { canonical: "Telluride", aliases: ["Telluride"], kinds: ["ski", "destination"] }
] satisfies KnownDestination[];

const knownDestinationByAlias = new Map(
  knownDestinations.flatMap((destination) => destination.aliases.map((alias) => [normalizeDestinationText(alias), destination] as const))
);

export function extractDestinationCandidatesFromText(text: string) {
  const normalizedText = text.replace(/[“”]/g, '"').replace(/[’]/g, "'");
  const candidates = new Set<string>();
  const suffixPattern =
    /\b((?:St\.?\s+|Saint\s+|Fort\s+)?[A-Z][A-Za-z'.-]*(?:\s+(?:and|of|the|de|del|la|le|du|[A-Z][A-Za-z'.-]*)){0,5}\s+(?:Beach|Beaches|Praia|Island|Islands|Park|Parks|Preserve|Trail|Trails|Falls|Valley|Village|Town|City|Neighborhood|Neighbourhood|District|Quarter|Region|Mountains|Mountain|Lake|Springs|Key|Keys|Point|Pier|Bay|Harbor|Harbour|Coast|Shore|Shores|Cove|Caves|Canyon|Gardens|Market|Museum|Monument))\b/g;
  const fortPattern = /\b(Fort\s+[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3})\b/g;
  const listContextPattern =
    /\b(?:include|includes|included|including|recommend|recommends|recommended|features?|featured|such as|like|among)\s+([^.;:!?]{3,180})/gi;

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

  for (const destination of knownDestinations) {
    for (const alias of destination.aliases) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");

      if (pattern.test(normalizedText)) {
        candidates.add(alias);
      }
    }
  }

  return Array.from(candidates).map(cleanDestinationCandidate).filter(Boolean).slice(0, 30);
}

export function canonicalDestinationName(name: string) {
  const compact = cleanDestinationCandidate(name);
  const normalized = normalizeDestinationText(compact.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  const knownDestination = knownDestinationByAlias.get(normalized);

  if (knownDestination) return knownDestination.canonical;
  if (/^(?:sao miguel|sao miguel island|miguel island)$/.test(normalized)) return "São Miguel Island";
  if (/^(?:the )?(?:(?:portugal(?:['’]?s|\s+s)) |portuguese )?azores(?: islands?)?$/.test(normalized)) return "Azores";

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

export function destinationCandidateProof(query: string, name: string, evidenceTexts: string[] = []) {
  const canonicalName = canonicalDestinationName(name);
  const normalized = normalizeDestinationText(canonicalName);
  const queryKind = destinationTypeFromQuery(normalizeDestinationText(query));
  const evidence = normalizeDestinationText(evidenceTexts.join(" "));
  const knownDestination = knownDestinationByAlias.get(normalized);

  if (isGenericDestinationContenderName(query, canonicalName)) {
    return { accepted: false, canonicalName, requiresMultipleSources: false, reason: "generic_or_malformed" };
  }

  if (knownDestination) {
    return destinationKindFitsQuery(queryKind, knownDestination.kinds, canonicalName, evidence)
      ? { accepted: true, canonicalName: knownDestination.canonical, requiresMultipleSources: false, proofPath: "known_destination" as DestinationProofPath }
      : { accepted: false, canonicalName: knownDestination.canonical, requiresMultipleSources: false, reason: "known_destination_wrong_type" };
  }

  if (hasStrongGeographicForm(canonicalName)) {
    return strongGeographicFormFitsQuery(queryKind, canonicalName, evidence)
      ? { accepted: true, canonicalName, requiresMultipleSources: false, proofPath: "strong_geographic_form" as DestinationProofPath }
      : { accepted: false, canonicalName, requiresMultipleSources: false, reason: "strong_form_wrong_type" };
  }

  if (hasDestinationRecommendationContext(evidence) && plainContextualDestinationFitsQuery(queryKind, canonicalName, evidence)) {
    return { accepted: true, canonicalName, requiresMultipleSources: true, proofPath: "repeated_contextual" as DestinationProofPath };
  }

  return { accepted: false, canonicalName, requiresMultipleSources: false, reason: "unproven_plain_entity" };
}

export function destinationCandidateFitsQuery(query: string, name: string, evidenceTexts: string[] = []) {
  const proof = destinationCandidateProof(query, name, evidenceTexts);

  return proof.accepted && (!proof.requiresMultipleSources || evidenceTexts.some((text) => /\brepeated_contextual\b/.test(text)));
}

export function isGenericDestinationContenderName(query: string, name: string) {
  const normalized = normalizeDestinationText(name.replace(/([a-z])([A-Z])/g, "$1 $2"));
  const queryText = normalizeDestinationText(query);
  const querySubject = queryText
    .replace(/\b(best|top|recommended|great|good|where to|places? to|things to|visit|stay|from|near|around|in|the|a|an|for|vacation|summer)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length < 3) return true;
  if (normalized === querySubject) return true;
  if (queryText.includes(` in ${normalized}`) || queryText.includes(` from ${normalized}`) || queryText.includes(` near ${normalized}`) || queryText.endsWith(` ${normalized}`)) {
    return true;
  }
  if (/^(?:a|an|and|as|at|be|by|fi|for|from|if|in|into|is|it|of|on|or|the|this|to|with)$/.test(normalized)) return true;
  if (/\b(?:this year|next year|summer|winter|spring|fall|autumn|today|tonight|weekend)\b/.test(normalized)) return true;
  if (/^(?:visit|visiting|discover|discovering|explore|exploring)\b/.test(normalized) && /\b(?:this year|soon|now|next)\b/.test(normalized)) return true;
  if (/^(?:what|which)\s+(?:caribbean\s+)?islands?\b/.test(normalized)) return true;
  if (/^(?:what|which)\s+[a-z]+$/.test(normalized)) return true;
  if (/^(?:all\s+inclusive|all-inclusive)\s+islands?\b/.test(normalized)) return true;
  if (/^(?:east|west|north|south)(?:ern)?\s+(?:coast|side|shore)\b/.test(normalized)) return true;
  if (/^(?:best|top|recommended|popular|underrated|hidden|secret|beautiful|amazing|favorite|favourite|must visit|essential)\s+[a-z]+(?:\s+[a-z]+)?$/.test(normalized)) {
    return true;
  }
  if (/\bislands?\b/.test(queryText) && !/\bbeach(?:es)?\b/.test(queryText) && /\bbeach(?:es)?\b/.test(normalized)) return true;
  if (
    /\band\b/.test(normalized) &&
    !/^(?:saint|st\.?)\s+kitts\s+and\s+nevis$/.test(normalized) &&
    !/^turks\s+and\s+caicos(?:\s+islands?)?$/.test(normalized)
  ) {
    return true;
  }
  if (
    /^(?:beach|beaches|neighborhood|neighborhoods|neighbourhood|neighbourhoods|island|islands|weekend trips?|day trips?|destinations?|places?|places to visit|things to do|where to stay|areas? to stay|travel guide|guide|tourism|tripadvisor|reddit|booking|hotels?|resorts?|best beaches|best islands|best neighborhoods?)$/.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /\b(?:where to stay|things to do|places to visit|best beaches|best islands|best neighborhoods|travel guide|itinerary|guide to|top \d+|best \d+|vacation packages?|message board|forum|thread|comments?)\b/.test(
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
    /^(?:visiting|exploring|discovering|guide to|where to|how to|visit)\b/.test(normalized) &&
    /\b(?:islands?|beaches|neighborhoods?|neighbourhoods?|destinations?|places?|regions?|towns?|year)\b/.test(normalized)
  ) {
    return true;
  }
  if (/\b(?:reddit|tripadvisor|booking|expedia|conde nast|travel leisure|time out|timeout|official tourism|tourism board)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:resort|resorts|hotel|hotels|lodging|all inclusive|all-inclusive)\b/.test(normalized) && destinationTypeFromQuery(queryText) !== "ski") {
    return true;
  }
  if (/[:|]/.test(name) && normalized.split(/\s+/).length >= 4) return true;

  return false;
}

export function hasDestinationRecommendationContext(text: string) {
  return /\b(?:best|top|recommended?|favorites?|favourites?|known for|include|includes|included|including|among|where to stay|places? to visit|destinations?|travel guide|vacation|honeymoon|ski|skiing)\b/i.test(
    text
  );
}

function extractCandidatesFromDestinationList(value: string) {
  return value
    .split(",")
    .flatMap((part) => part.split(/\s+and\s+(?=(?:the\s+)?[A-Z])/))
    .map(cleanDestinationCandidate)
    .filter((candidate) => isDestinationListCandidate(candidate));
}

function cleanDestinationCandidate(value: string) {
  return value
    .replace(/^[#*\d.\s-]+/, "")
    .replace(/^\s*(?:and|or|the)\s+/i, "")
    .replace(/\s+\b(?:for|because|with|when|where|while|that|which|to|as)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDestinationListCandidate(value: string) {
  if (!value || value.length < 3) return false;
  if (value.length > 60) return false;
  if (/^(?:food|scenery|culture|history|beaches|resorts?|hotels?|destinations?|places?|areas?|travelers?|visitors?|families|couples)$/i.test(value)) return false;

  return /^(?:The\s+)?(?:[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+|St\.|USVI)(?:\s+(?:and|of|the|de|del|la|le|du|[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+|St\.)){0,4}$/.test(value);
}

function hasStrongGeographicForm(name: string) {
  return /\b(?:Beach|Beaches|Praia|Island|Islands|Park|Preserve|Trail|Falls|Valley|Village|Town|City|Neighborhood|Neighbourhood|District|Quarter|Region|Mountains|Mountain|Lake|Springs|Key|Keys|Point|Bay|Harbor|Harbour|Coast|Shore|Shores|Cove|Caves|Canyon|Gardens|Museum|Monument)\b/.test(
    name
  );
}

function destinationKindFitsQuery(queryKind: DestinationKind, candidateKinds: DestinationKind[], name: string, evidence: string) {
  if (queryKind === "destination") return candidateKinds.includes("destination") || candidateKinds.length > 0;
  if (candidateKinds.includes(queryKind)) return true;

  if (queryKind === "beach") {
    return /\b(?:beach|beaches|praia|coast|shore|cove|bay|seaside|waterfront)\b/.test(normalizeDestinationText(name)) || /\b(?:beach|beaches|praia|coast|shore|cove|bay|seaside|waterfront)\b/.test(evidence);
  }

  return false;
}

function strongGeographicFormFitsQuery(queryKind: DestinationKind, name: string, evidence: string) {
  const normalizedName = normalizeDestinationText(name);

  if (queryKind === "island") return /\bislands?\b/.test(normalizedName) || /\bisland destination\b/.test(evidence);
  if (queryKind === "beach") return /\b(?:beach|beaches|praia|coast|shore|cove|bay)\b/.test(normalizedName) || /\b(?:beach|beaches|praia|coast|shore|cove|bay)\b/.test(evidence);
  if (queryKind === "neighborhood") {
    return /\b(?:neighborhood|neighbourhood|district|quarter|village)\b/.test(normalizedName) || /\b(?:where to stay|neighborhood|neighbourhood|district|quarter|area to stay|areas to stay|stay in)\b/.test(evidence);
  }
  if (queryKind === "ski") return /\b(?:ski|skiing|snowboard|mountain|resort|village|town)\b/.test(normalizedName) || /\b(?:ski|skiing|snowboard|mountain|resort|powder|slopes?)\b/.test(evidence);

  return hasDestinationRecommendationContext(evidence);
}

function plainContextualDestinationFitsQuery(queryKind: DestinationKind, name: string, evidence: string) {
  const normalizedName = normalizeDestinationText(name);

  if (!/^(?:[a-z][a-z'.-]+)(?:\s+(?:and|of|the|de|del|la|le|du|[a-z][a-z'.-]+)){0,3}$/.test(normalizedName)) return false;
  if (queryKind === "island") return /\b(?:island|islands|island destination|caribbean|greek islands?)\b/.test(evidence);
  if (queryKind === "beach") return /\b(?:beach|beaches|praia|coast|shore|cove|bay|seaside|waterfront)\b/.test(evidence);
  if (queryKind === "neighborhood") return /\b(?:where to stay|neighborhood|neighbourhood|district|quarter|area to stay|areas to stay|stay in)\b/.test(evidence);
  if (queryKind === "ski") return /\b(?:ski|skiing|snowboard|mountain|resort|powder|slopes?)\b/.test(evidence);

  return /\b(?:destination|destinations|places? to visit|travel guide|vacation|honeymoon|visit|recommend|recommended)\b/.test(evidence);
}

function destinationTypeFromQuery(query: string): DestinationKind {
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

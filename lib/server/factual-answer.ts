import OpenAI from "openai";
import { z } from "zod";
import type { FactualAnswerResponse, VeraSource } from "@/lib/types";
import type { ConsensusEligibility } from "@/lib/utils";
import { canonicalizeQuery, domainFromUrl, normalizeQuery, slugify } from "@/lib/utils";

const factualSearchTimeoutMs = 4500;
const factualOpenAITimeoutMs = 6500;
const factualOpenAIModel = "gpt-4.1-mini";
const maxFactualSources = 5;
const maxFactualSnippetChars = 700;

type TavilyFactualResult = {
  title?: string;
  url?: string;
  content?: string;
};

const FactualAnswerSchema = z.object({
  verified: z.boolean(),
  answer: z.string().trim().min(1),
  heading: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  items: z.array(z.string().trim().min(1)).max(10).optional(),
  urgentGuidance: z.string().trim().min(1).optional(),
  urgency: z.enum(["none", "prompt_care", "emergency"]).optional(),
  presentation: z.enum(["short_fact", "explanatory_fact", "sensitive_fact"]).optional()
});

export async function answerFactualQuestion(query: string, eligibility: ConsensusEligibility): Promise<FactualAnswerResponse> {
  const normalizedQuery = normalizeQuery(query);
  const canonicalQuery = canonicalizeQuery(query);
  const createdAt = new Date().toISOString();
  const isSensitive = isSensitiveFactualQuestion(query);
  const sources = await retrieveFactualSources(query, eligibility.reason).catch((error) => {
    console.warn("[vera:factual] source retrieval failed", {
      query,
      reason: eligibility.reason,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  });
  const generated = await generateGroundedFactualAnswer(query, eligibility.reason, sources, isSensitive).catch((error) => {
    console.warn("[vera:factual] answer generation failed", {
      query,
      reason: eligibility.reason,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  });
  const verified = Boolean(generated?.verified && generated?.answer.trim());
  const answer = verified && generated ? generated.answer.trim() : "This is a direct factual question, but I couldn't verify a reliable current answer.";
  const detectedUrgency = classifyFactualUrgency(query);
  const urgency = verified ? (detectedUrgency === "emergency" ? "emergency" : generated?.urgency ?? detectedUrgency) : "none";
  const urgentGuidance = verified ? generated?.urgentGuidance ?? emergencyGuidanceFromSources(query, sources, urgency) : undefined;
  const items = verified ? generated?.items?.length ? generated.items : emergencyItemsFromGroundedText(query, answer, sources) : undefined;
  const inferredPresentation = presentationForFactualAnswer(query, answer, isSensitive, urgency);
  const presentation = verified
    ? isSensitive || urgency !== "none"
      ? "sensitive_fact"
      : inferredPresentation === "explanatory_fact"
        ? inferredPresentation
        : generated?.presentation ?? inferredPresentation
    : "short_fact";

  return {
    type: "factual_answer",
    id: `factual-${slugify(normalizedQuery)}-${Date.now()}`,
    query,
    normalizedQuery,
    canonicalQuery,
    isSensitive,
    personalityLine: isSensitive ? undefined : personalityLineForFactualQuestion(query),
    boundaryMessage: isSensitive ? "This is a direct factual question, so Vera is answering it directly." : "But since you asked...",
    heading: verified ? generated?.heading ?? emergencyHeadingForQuery(query) : undefined,
    summary: verified ? generated?.summary ?? emergencySummaryForQuery(query, urgency) : undefined,
    items,
    urgentGuidance,
    urgency,
    presentation,
    answer,
    sources: verified ? sources : [],
    createdAt,
    generated_at: createdAt,
    cached: false,
    factualAnswerVerified: verified,
    unsupportedReason: eligibility.reason
  };
}

export function buildFactualAnswerResponseForRegression({
  answer = "Regression factual answer.",
  heading,
  items,
  query,
  summary,
  sources = regressionSources(),
  urgentGuidance,
  urgency,
  presentation,
  verified = true
}: {
  answer?: string;
  heading?: string;
  items?: string[];
  query: string;
  summary?: string;
  sources?: VeraSource[];
  urgentGuidance?: string;
  urgency?: FactualAnswerResponse["urgency"];
  presentation?: FactualAnswerResponse["presentation"];
  verified?: boolean;
}): FactualAnswerResponse {
  const eligibilityReason = "who_won";
  const createdAt = "2026-01-01T00:00:00.000Z";
  const isSensitive = isSensitiveFactualQuestion(query);
  const detectedUrgency = urgency ?? classifyFactualUrgency(query);
  const resolvedPresentation =
    isSensitive || detectedUrgency !== "none" ? "sensitive_fact" : presentation ?? presentationForFactualAnswer(query, answer, isSensitive, detectedUrgency);

  return {
    type: "factual_answer",
    id: `factual-${slugify(normalizeQuery(query))}-regression`,
    query,
    normalizedQuery: normalizeQuery(query),
    canonicalQuery: canonicalizeQuery(query),
    isSensitive,
    personalityLine: isSensitive ? undefined : personalityLineForFactualQuestion(query),
    boundaryMessage: isSensitive ? "This is a direct factual question, so Vera is answering it directly." : "But since you asked...",
    heading: verified ? heading : undefined,
    summary: verified ? summary : undefined,
    items: verified ? items : undefined,
    urgentGuidance: verified ? urgentGuidance : undefined,
    urgency: verified ? detectedUrgency : "none",
    presentation: verified ? resolvedPresentation : "short_fact",
    answer: verified ? answer : "This is a direct factual question, but I couldn't verify a reliable current answer.",
    sources: verified ? sources : [],
    createdAt,
    generated_at: createdAt,
    cached: false,
    factualAnswerVerified: verified,
    unsupportedReason: eligibilityReason
  };
}

export function isSensitiveFactualQuestion(query: string) {
  const normalized = normalizeQuery(query);

  return /\b(?:symptoms?|diagnos(?:e|is)|treatment|medicine|medication|dose|dosage|side effects?|interactions?|acetaminophen|ibuprofen|alcohol|doctor|hospital|suicide|self harm|self-harm|kill myself|abuse|assault|crime|criminal|lawsuit|legal|lawyer|attorney|arrest|bankruptcy|tax|immigration|visa|election|war|terrorism|shooting|death|died|murder|rape|pregnan(?:t|cy)|cancer|heart attack|stroke)\b/.test(
    normalized
  );
}

export function classifyFactualUrgency(query: string): FactualAnswerResponse["urgency"] {
  const normalized = normalizeQuery(query);

  if (/\b(?:heart attack|stroke|cardiac arrest|overdose|suicide|self harm|self-harm|poisoning|anaphylaxis|choking)\b/.test(normalized)) {
    return "emergency";
  }

  if (isSensitiveFactualQuestion(query)) {
    return "prompt_care";
  }

  return "none";
}

function emergencyGuidanceFromSources(query: string, sources: VeraSource[], urgency: FactualAnswerResponse["urgency"]) {
  if (urgency !== "emergency") {
    return undefined;
  }

  const normalized = normalizeQuery(query);
  if (!/\b(?:heart attack|stroke|cardiac arrest|overdose|poisoning|anaphylaxis|choking)\b/.test(normalized)) {
    return undefined;
  }

  const sourceText = sources.map((source) => `${source.title} ${source.snippet ?? ""} ${source.domain}`).join(" ");
  if (!/\b(?:call|dial|contact)\s*(?:9-?1-?1|911|emergency)|\b911\b|\b9-1-1\b|\bemergency (?:services|number|care)\b/i.test(sourceText)) {
    const hasOfficialEmergencyHealthSource = sources.some((source) => /\b(?:heart\.org|medlineplus\.gov|cdc\.gov)\b/i.test(source.domain));
    if (!hasOfficialEmergencyHealthSource) {
      return undefined;
    }
  }

  return "If you or someone else may be having these symptoms now, call 911 immediately.";
}

function emergencyHeadingForQuery(query: string) {
  const normalized = normalizeQuery(query);

  if (/\bheart attack\b/.test(normalized)) {
    return "Heart attack warning signs";
  }

  if (/\bstroke\b/.test(normalized)) {
    return "Stroke warning signs";
  }

  return undefined;
}

function emergencySummaryForQuery(query: string, urgency: FactualAnswerResponse["urgency"]) {
  if (urgency !== "emergency") {
    return undefined;
  }

  const normalized = normalizeQuery(query);
  if (/\bheart attack\b/.test(normalized)) {
    return "Symptoms can vary and may be less obvious in some people. This list is not exhaustive.";
  }

  if (/\bstroke\b/.test(normalized)) {
    return "Stroke symptoms are often sudden. This list is not exhaustive.";
  }

  return undefined;
}

function emergencyItemsFromGroundedText(query: string, answer: string, sources: VeraSource[]) {
  const normalized = normalizeQuery(query);
  const text = normalizeQuery([answer, ...sources.map((source) => `${source.title} ${source.snippet ?? ""}`)].join(" "));

  const candidates = /\bheart attack\b/.test(normalized)
    ? [
        { label: "Chest pressure, squeezing, fullness, pain, or other discomfort", pattern: /\b(?:chest|pressure|squeezing|fullness|pain|discomfort|crushing)\b/ },
        { label: "Shortness of breath", pattern: /\bshortness of breath\b|\bbreath(?:ing)?\b/ },
        { label: "Pain or discomfort in one or both arms, the back, neck, jaw, shoulder, or stomach", pattern: /\b(?:arms?|back|neck|jaw|shoulder|stomach|upper body)\b/ },
        { label: "Cold sweat", pattern: /\bcold sweat|sweating\b/ },
        { label: "Nausea or vomiting", pattern: /\bnausea|vomiting|vomit\b/ },
        { label: "Light-headedness or dizziness", pattern: /\blightheaded|light headed|dizziness|dizzy\b/ },
        { label: "Unusual tiredness or weakness", pattern: /\btiredness|fatigue|weakness|weak\b/ }
      ]
    : /\bstroke\b/.test(normalized)
      ? [
          { label: "Face drooping or numbness", pattern: /\bface|droop|numbness|numb\b/ },
          { label: "Arm weakness or numbness", pattern: /\barm|weakness|weak|numbness|numb\b/ },
          { label: "Speech trouble or confusion", pattern: /\bspeech|speaking|confusion|confused|understanding\b/ },
          { label: "Vision trouble", pattern: /\bvision|seeing|sight\b/ },
          { label: "Trouble walking, dizziness, or loss of balance", pattern: /\bwalking|dizziness|dizzy|balance|coordination\b/ },
          { label: "Sudden severe headache", pattern: /\bheadache\b/ }
        ]
      : [];

  const items = candidates.filter((candidate) => candidate.pattern.test(text)).map((candidate) => candidate.label);

  return items.length ? items : undefined;
}

function presentationForFactualAnswer(
  query: string,
  answer: string,
  isSensitive: boolean,
  urgency: FactualAnswerResponse["urgency"] = "none"
): FactualAnswerResponse["presentation"] {
  if (isSensitive || urgency !== "none") {
    return "sensitive_fact";
  }

  if (/^why\b/.test(normalizeQuery(query))) {
    return "explanatory_fact";
  }

  const sentenceCount = answer.match(/[.!?](?:\s|$)/g)?.length ?? 0;
  const wordCount = answer.trim().split(/\s+/).filter(Boolean).length;

  if (answer.length > 180 || wordCount > 28 || sentenceCount > 1 || /\n|^\s*[-*]/m.test(answer)) {
    return "explanatory_fact";
  }

  return "short_fact";
}

export function personalityLineForFactualQuestion(query: string) {
  const lines = [
    "No consensus needed here. Lucky us.",
    "Tiny detour from the recommendation mines.",
    "This one has a factual answer, not a vibes-based leaderboard."
  ];
  const normalized = normalizeQuery(query);
  const hash = normalized.split("").reduce((total, char) => total + char.charCodeAt(0), 0);

  return lines[hash % lines.length];
}

async function retrieveFactualSources(query: string, eligibilityReason?: string): Promise<VeraSource[]> {
  const key = process.env.TAVILY_API_KEY;

  if (!key) {
    throw new Error("TAVILY_API_KEY is required for factual answers.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-API-Key": key
    },
    body: JSON.stringify({
      query: factualSearchQuery(query, eligibilityReason),
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      max_results: maxFactualSources
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(factualSearchTimeoutMs)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Tavily factual search failed with ${response.status}. ${detail || "No response body returned."}`);
  }

  const body = (await response.json()) as { results?: TavilyFactualResult[] };

  return (body.results ?? [])
    .filter((item): item is Required<Pick<TavilyFactualResult, "title" | "url">> & TavilyFactualResult => Boolean(item.title && item.url))
    .map((item) => ({
      title: item.title,
      url: item.url,
      domain: domainFromUrl(item.url),
      snippet: item.content?.slice(0, maxFactualSnippetChars)
    }))
    .filter((source, index, sources) => sources.findIndex((candidate) => candidate.url === source.url) === index)
    .slice(0, maxFactualSources);
}

async function generateGroundedFactualAnswer(
  query: string,
  eligibilityReason: string | undefined,
  sources: VeraSource[],
  isSensitive: boolean
): Promise<z.infer<typeof FactualAnswerSchema>> {
  const key = process.env.OPENAI_API_KEY;

  if (!key || !sources.length) {
    return { verified: false, answer: "" };
  }

  const openai = new OpenAI({ apiKey: key, timeout: factualOpenAITimeoutMs, maxRetries: 0 });
  const sourceText = sources
    .map((source, index) =>
      [
        `SOURCE ${index + 1}`,
        `Title: ${source.title}`,
        `URL: ${source.url}`,
        `Domain: ${source.domain}`,
        `Snippet: ${sanitizeFactualSnippet(source.snippet ?? "")}`
      ].join("\n")
    )
    .join("\n\n");

  const completion = await openai.chat.completions.create(
    {
      model: factualOpenAIModel,
      temperature: 0,
      max_completion_tokens: 420,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            'Return valid JSON with this shape: {"verified":true,"answer":"","heading":"","summary":"","items":[],"urgentGuidance":"","urgency":"none","presentation":"short_fact"}.',
            "Only verified and answer are required; omit optional fields when they are not useful.",
            "Answer the user's direct factual question using only the provided sources.",
            "If the provided sources do not verify the answer, return verified false and answer empty.",
            "Do not provide recommendation consensus, rankings, confidence, contenders, or opinion framing.",
            "For short factual answers, set presentation to short_fact and keep answer concise.",
            "For longer explanatory answers, set presentation to explanatory_fact and put concise context in summary when useful.",
            "For sensitive medical, legal, financial, or safety answers, set presentation to sensitive_fact and use neutral body-safe language.",
            "For symptom/sign questions, provide a short heading and items only when the sources support a clear list; do not make the list sound exhaustive.",
            "For emergency medical or safety topics where delay could be dangerous, set urgency to emergency and include urgentGuidance only when supported by sources.",
            "For heart attack or stroke symptoms, urgentGuidance should clearly tell the user to call 911 immediately if symptoms may be happening now.",
            isSensitive ? "Use a neutral, direct tone. Do not use humor or playful transitions." : "Use a concise, plain answer.",
            "Mention dates or years when they are needed to avoid ambiguity.",
            `Eligibility reason: ${eligibilityReason ?? "objective_factual"}.`
          ].join(" ")
        },
        {
          role: "user",
          content: [`Question: ${query}`, "", sourceText].join("\n")
        }
      ]
    },
    {
      timeout: factualOpenAITimeoutMs,
      maxRetries: 0
    }
  );

  const content = completion.choices[0]?.message.content;

  if (!content) {
    return { verified: false, answer: "" };
  }

  const parsed = FactualAnswerSchema.safeParse(JSON.parse(content));

  return parsed.success ? parsed.data : { verified: false, answer: "" };
}

function factualSearchQuery(query: string, eligibilityReason?: string) {
  if (eligibilityReason === "capital_question") {
    return `${query} official`;
  }

  if (eligibilityReason === "who_won" || eligibilityReason === "who_is_role") {
    return `${query} official current result`;
  }

  return `${query} reliable source`;
}

function sanitizeFactualSnippet(snippet: string) {
  return snippet
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxFactualSnippetChars);
}

function regressionSources(): VeraSource[] {
  return [
    {
      title: "Regression source",
      url: "https://example.com/factual-source",
      domain: "example.com",
      snippet: "Regression factual source."
    }
  ];
}

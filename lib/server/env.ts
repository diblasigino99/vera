export function getLiveSearchSetup() {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasTavily = Boolean(process.env.TAVILY_API_KEY);

  return {
    hasOpenAI,
    hasTavily,
    ready: hasOpenAI && hasTavily,
    missing: [
      hasOpenAI ? null : "OPENAI_API_KEY",
      hasTavily ? null : "TAVILY_API_KEY"
    ].filter((key): key is string => Boolean(key))
  };
}

export function liveSearchSetupMessage(missing: string[]) {
  return `Live search is not configured. Add ${missing.join(" and ")} to .env.local, then restart the dev server.`;
}

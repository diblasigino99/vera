import { redirect } from "next/navigation";
import type { Route } from "next";

type LegacySearchPageProps = {
  searchParams: Promise<{
    q?: string;
    thinking?: string;
  }>;
};

export default async function LegacySearchPage({ searchParams }: LegacySearchPageProps) {
  const params = await searchParams;
  const nextParams = new URLSearchParams();

  if (typeof params.q === "string" && params.q.trim()) {
    nextParams.set("q", params.q);
  }

  if (typeof params.thinking === "string" && params.thinking) {
    nextParams.set("thinking", params.thinking);
  }

  const queryString = nextParams.toString();

  redirect(`/vera/search${queryString ? `?${queryString}` : ""}` as Route);
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import type { ProfileSnapshot } from "@/lib/types";
import { getAnonymousId } from "@/lib/client/anonymous-id";
import { buildResultSlug } from "@/lib/result-slug";

const emptySnapshot: ProfileSnapshot = {
  recentSearches: [],
  savedSearches: [],
  savedResults: []
};

export function ProfileView() {
  const [snapshot, setSnapshot] = useState<ProfileSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextActorId = getAnonymousId();

    fetch(`/api/profile?actorId=${encodeURIComponent(nextActorId)}`)
      .then(async (response) => {
        const body = await response.json();

        if (!response.ok) {
          throw new Error(body.error ?? "Could not load saved items.");
        }

        return body as ProfileSnapshot;
      })
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
      })
      .catch((reason: Error) => {
        setError(reason.message);
      })
      .finally(() => setLoading(false));
  }, []);

  function clearSession() {
    window.localStorage.removeItem("vera_anonymous_id");
    window.location.href = "/vera";
  }

  return (
    <section className="mx-auto mt-14 max-w-4xl">
      <header className="border-b border-[#ECECF0] pb-10">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Saved Library</p>
        <h1 className="mt-5 text-5xl font-semibold tracking-[-0.025em] text-[#111114] sm:text-6xl">Your saved Vera research.</h1>
        <p className="mt-6 max-w-2xl text-xl leading-9 text-[#4B4B52]">
          {loading ? "Loading your saved library..." : error ?? "Saved searches and recommendations from this browser live here."}
        </p>
      </header>

      <div className="mt-12 grid gap-14">
        <LibrarySection title="Saved Searches" description="Questions you wanted to return to.">
          {snapshot.savedSearches.length ? (
            <div className="border-t border-[#ECECF0]">
              {snapshot.savedSearches.map((search) => (
                <SavedSearchRow search={search} key={search.id} />
              ))}
            </div>
          ) : (
            <Empty message="No saved searches yet." />
          )}
        </LibrarySection>

        <LibrarySection title="Saved Recommendations" description="Specific recommendations you saved from a consensus result.">
          {snapshot.savedResults.length ? (
            <div className="border-t border-[#ECECF0]">
              {snapshot.savedResults.map((result) => (
                <SavedResultRow result={result} key={`${result.searchId}-${result.resultId}`} />
              ))}
            </div>
          ) : (
            <Empty message="No saved recommendations yet." />
          )}
        </LibrarySection>

        <LibrarySection title="Account" description="You're using Vera in this browser.">
          <div className="border-t border-[#ECECF0] py-5">
            <div className="grid gap-3 sm:grid-cols-[0.35fr_0.65fr]">
              <p className="font-medium text-[#111114]">Browser session</p>
              <div>
                <p className="text-[#4B4B52]">Your saved searches and recommendations are stored privately in this browser for now.</p>
              </div>
            </div>
          </div>
        </LibrarySection>

        <LibrarySection title="Support" description="A few quiet essentials.">
          <div className="border-t border-[#ECECF0]">
            <SupportLink href="mailto:hello@nexraai.com?subject=Vera%20feedback" label="Send Feedback" />
            <SupportLink href="/privacy" label="Privacy Policy" />
            <SupportLink href="/terms" label="Terms of Service" />
            <button
              type="button"
              onClick={clearSession}
              className="flex w-full items-center justify-between border-b border-[#ECECF0] py-4 text-left text-sm font-medium text-[#73737C] transition hover:text-[#111114]"
            >
              Clear local session / Sign out
              <span aria-hidden="true">Reset</span>
            </button>
          </div>
        </LibrarySection>
      </div>
    </section>
  );
}

function LibrarySection({ children, description, title }: { children: React.ReactNode; description: string; title: string }) {
  return (
    <section>
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">{title}</p>
      <p className="mt-3 max-w-2xl leading-7 text-[#73737C]">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function SavedSearchRow({ search }: { search: ProfileSnapshot["savedSearches"][number] }) {
  return (
    <Link
      className="group block border-b border-[#ECECF0] py-5 transition hover:border-[#D8D9DE]"
      href={`/vera/search?q=${encodeURIComponent(search.query)}`}
    >
      <p className="text-xl font-semibold tracking-[-0.01em] text-[#111114] group-hover:text-black">{search.query}</p>
      <p className="mt-2 line-clamp-2 leading-7 text-[#62626A]">{search.headline}</p>
    </Link>
  );
}

function SavedResultRow({ result }: { result: ProfileSnapshot["savedResults"][number] }) {
  return (
    <Link
      className="group block border-b border-[#ECECF0] py-5 transition hover:border-[#D8D9DE]"
      href={`/vera/result/${buildResultSlug(result.name, result.searchId, result.resultId)}` as Route}
      prefetch={false}
    >
      <p className="text-xl font-semibold tracking-[-0.01em] text-[#111114] group-hover:text-black">{result.name}</p>
      <p className="mt-2 text-sm font-medium uppercase tracking-[0.14em] text-[#9B9BA3]">From search</p>
      <p className="mt-1 leading-7 text-[#62626A]">{result.query}</p>
    </Link>
  );
}

function SupportLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="flex items-center justify-between border-b border-[#ECECF0] py-4 text-sm font-medium text-[#4B4B52] transition hover:text-[#111114]"
      href={href}
    >
      {label}
      <span aria-hidden="true">Open</span>
    </a>
  );
}

function Empty({ message }: { message: string }) {
  return <p className="border-t border-[#ECECF0] py-5 text-[#8A8A92]">{message}</p>;
}

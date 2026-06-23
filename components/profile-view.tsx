"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
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
    const actorId = getAnonymousId();

    fetch(`/api/profile?actorId=${encodeURIComponent(actorId)}`)
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

  return (
    <section className="mx-auto mt-14 max-w-5xl">
      <h1 className="text-4xl font-semibold tracking-normal text-ink">Profile</h1>
      <p className="mt-3 text-muted">
        {loading ? "Loading saved items..." : error ?? "Recent searches, saved searches, and saved results."}
      </p>

      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <Panel title="Recent searches">
          {snapshot.recentSearches.length ? (
            snapshot.recentSearches.map((search) => (
              <Link className="block rounded-lg border border-line p-4 transition hover:bg-mist" href={`/search?q=${encodeURIComponent(search.query)}`} key={search.id}>
                <p className="font-medium text-ink">{search.query}</p>
                <p className="mt-2 text-sm text-muted">{search.headline}</p>
              </Link>
            ))
          ) : (
            <Empty />
          )}
        </Panel>

        <Panel title="Saved searches">
          {snapshot.savedSearches.length ? (
            snapshot.savedSearches.map((search) => (
              <Link className="block rounded-lg border border-line p-4 transition hover:bg-mist" href={`/search?q=${encodeURIComponent(search.query)}`} key={search.id}>
                <p className="font-medium text-ink">{search.query}</p>
                <p className="mt-2 text-sm text-muted">{search.headline}</p>
              </Link>
            ))
          ) : (
            <Empty />
          )}
        </Panel>

        <Panel title="Saved results">
          {snapshot.savedResults.length ? (
            snapshot.savedResults.map((result) => (
              <Link
                className="block rounded-lg border border-line p-4 transition hover:bg-mist"
                href={`/result/${buildResultSlug(result.name, result.searchId, result.resultId)}` as Route}
                prefetch={false}
                key={`${result.searchId}-${result.resultId}`}
              >
                <p className="font-medium text-ink">{result.name}</p>
                <p className="mt-2 text-sm text-muted">{result.query}</p>
              </Link>
            ))
          ) : (
            <Empty />
          )}
        </Panel>
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="mb-4 text-xl font-medium text-ink">{title}</h2>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function Empty() {
  return <p className="rounded-lg bg-mist p-4 text-sm text-muted">Nothing saved yet.</p>;
}

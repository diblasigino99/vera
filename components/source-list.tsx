import type { VeraSource } from "@/lib/types";

export function SourceList({ sources }: { sources: VeraSource[] }) {
  return (
    <div>
      <h2 className="text-xl font-medium text-ink">Sources / original discussions</h2>
      <div className="mt-4 grid gap-3">
        {sources.map((source) => (
          <a
            className="rounded-lg border border-line p-4 transition hover:bg-mist"
            href={source.url}
            key={source.url}
            rel="noreferrer"
            target="_blank"
          >
            <p className="font-medium text-ink">{source.title}</p>
            <p className="mt-1 text-sm text-muted">{source.domain}</p>
            {source.snippet ? <p className="mt-3 leading-7 text-graphite">{source.snippet}</p> : null}
          </a>
        ))}
      </div>
    </div>
  );
}

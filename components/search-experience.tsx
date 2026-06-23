"use client";

import { FormEvent, MouseEvent, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { VeraThinking } from "@/components/vera-thinking";

type SearchExperienceProps = {
  initialQuery?: string;
  compact?: boolean;
  autoFocus?: boolean;
};

export function SearchExperience({ initialQuery = "", compact = false, autoFocus = false }: SearchExperienceProps) {
  const [query, setQuery] = useState(initialQuery);
  const [isSubmittingSearch, setIsSubmittingSearch] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = query.trim();

    if (!nextQuery) {
      return;
    }

    console.log("SEARCH_SUBMIT_ONCE", { query: nextQuery, source: "search-experience" });
    setIsSubmittingSearch(true);
    console.log("thinking state visible", { query: nextQuery });

    window.setTimeout(() => {
      startTransition(() => {
        router.push(`/search?q=${encodeURIComponent(nextQuery)}&thinking=1`);
        setIsSubmittingSearch(false);
      });
    }, 2000);
  }

  function onIconClick(event: MouseEvent<HTMLButtonElement>) {
    if (!query.trim()) {
      event.preventDefault();
      inputRef.current?.focus();
    }
  }

  return (
    <div>
      <form
        onSubmit={onSubmit}
        className={cn(
          "search-glow mx-auto flex w-full items-center gap-3 border border-[#E3E3E7] bg-white transition duration-300 focus-within:border-[#D7DCE4]",
          compact
            ? "max-w-[57.6rem] rounded-[1.8rem] px-5 py-3.5 shadow-[0_16px_48px_rgba(0,0,0,0.052)]"
            : "max-w-[36.5rem] rounded-[1.5rem] px-4 py-3 shadow-none"
        )}
        data-active={Boolean(query.trim())}
        data-loading={isPending || isSubmittingSearch}
      >
        <button
          type="submit"
          aria-label="Search"
          disabled={isPending || isSubmittingSearch}
          onClick={onIconClick}
          className={cn(
            "grid shrink-0 place-items-center rounded-full text-[#7D7D85] transition duration-300 hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D7DCE4]",
            compact ? "h-8 w-8" : "h-7 w-7"
          )}
        >
          <Search className={cn(compact ? "h-[1.1rem] w-[1.1rem]" : "h-[1.05rem] w-[1.05rem]")} strokeWidth={1.7} />
        </button>
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What are you trying to decide?"
          className={cn(
            "ml-1 w-full bg-transparent font-normal leading-none tracking-[0.005em] text-[#111111] outline-none transition duration-300 placeholder:font-normal placeholder:text-[#9A9AA0] placeholder:transition-colors focus:placeholder:text-[#C2C2C7]",
            compact ? "h-8 text-xl" : "h-7 text-base"
          )}
        />
      </form>
      {isSubmittingSearch ? <VeraThinking className="mt-5" /> : null}
    </div>
  );
}

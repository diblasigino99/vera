"use client";

import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { VeraThinking } from "@/components/vera-thinking";

type SearchExperienceProps = {
  initialQuery?: string;
  compact?: boolean;
  autoFocus?: boolean;
  rotatingPlaceholders?: string[];
};

export function SearchExperience({ initialQuery = "", compact = false, autoFocus = false, rotatingPlaceholders = [] }: SearchExperienceProps) {
  const [query, setQuery] = useState(initialQuery);
  const [isFocused, setIsFocused] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [isSubmittingSearch, setIsSubmittingSearch] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const canRotatePlaceholder = rotatingPlaceholders.length > 0 && !compact;
  const activePlaceholder = useMemo(() => {
    if (!canRotatePlaceholder) {
      return "What are you trying to decide?";
    }

    return rotatingPlaceholders[placeholderIndex % rotatingPlaceholders.length];
  }, [canRotatePlaceholder, placeholderIndex, rotatingPlaceholders]);
  const showVisualPlaceholder = canRotatePlaceholder && !query.trim() && !isFocused;

  useEffect(() => {
    if (!canRotatePlaceholder || isFocused || query.trim()) {
      return;
    }

    const timer = window.setInterval(() => {
      setPlaceholderIndex((index) => (index + 1) % rotatingPlaceholders.length);
    }, 3600);

    return () => window.clearInterval(timer);
  }, [canRotatePlaceholder, isFocused, query, rotatingPlaceholders.length]);

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
          "search-glow mx-auto flex w-full items-center gap-3 border border-[#E3E3E7] bg-white transition duration-300 hover:-translate-y-px hover:border-[#D8DAE0] hover:shadow-[0_14px_34px_rgba(0,0,0,0.055)] focus-within:border-[#D7DCE4]",
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
        <div className="relative ml-1 min-w-0 flex-1">
          {showVisualPlaceholder ? (
            <span
              className="pointer-events-none absolute inset-y-0 left-0 flex items-center truncate text-base font-normal tracking-[0.005em] text-[#9A9AA0] transition-opacity duration-500"
              key={activePlaceholder}
            >
              <span className="animate-placeholder-fade truncate">{activePlaceholder}</span>
            </span>
          ) : null}
          <input
            ref={inputRef}
            autoFocus={autoFocus}
            value={query}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={showVisualPlaceholder ? "" : activePlaceholder}
            className={cn(
              "w-full bg-transparent font-normal leading-none tracking-[0.005em] text-[#111111] outline-none transition duration-300 placeholder:font-normal placeholder:text-[#9A9AA0] placeholder:transition-colors focus:placeholder:text-[#C2C2C7]",
              compact ? "h-8 text-xl" : "h-7 text-base"
            )}
          />
        </div>
      </form>
      {isSubmittingSearch ? <VeraThinking className="mt-5" /> : null}
    </div>
  );
}

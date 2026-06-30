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
    }, 3900);

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
          "search-glow mx-auto flex w-full items-center gap-3 border border-[#E2E3E7] bg-white transition duration-500 ease-out hover:-translate-y-[1px] hover:border-[#D6D7DD] hover:shadow-[0_18px_44px_rgba(17,17,20,0.06)] focus-within:border-transparent focus-within:shadow-[0_20px_54px_rgba(17,17,20,0.08)]",
          compact
            ? "max-w-[57.6rem] rounded-[1.65rem] px-5 py-3.5 shadow-[0_16px_48px_rgba(17,17,20,0.05)]"
            : "max-w-[37rem] rounded-[1.62rem] px-[1.25rem] py-[1rem] shadow-[0_15px_42px_rgba(17,17,20,0.045)]"
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
            "grid shrink-0 place-items-center rounded-full text-[#7A7A82] transition duration-300 hover:bg-[#F6F6F8] hover:text-[#111114] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D7DCE4] disabled:cursor-default disabled:opacity-70",
            compact ? "h-8 w-8" : "h-8 w-8"
          )}
        >
          <Search className={cn(compact ? "h-[1.08rem] w-[1.08rem]" : "h-[1rem] w-[1rem]")} strokeWidth={1.65} />
        </button>
        <div className="relative ml-1.5 min-w-0 flex-1">
          {showVisualPlaceholder ? (
            <span
              className="pointer-events-none absolute inset-y-0 left-0 flex items-center truncate text-base font-normal tracking-[0.002em] text-[#9D9DA4] transition-opacity duration-700"
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
              "w-full cursor-text bg-transparent font-normal leading-none tracking-[0.002em] text-[#111111] caret-[#111114] outline-none transition duration-300 placeholder:font-normal placeholder:text-[#9D9DA4] placeholder:transition-colors focus:placeholder:text-[#C4C4CA]",
              compact ? "h-8 text-xl" : "h-8 text-base"
            )}
          />
        </div>
      </form>
      {isSubmittingSearch ? <VeraThinking className="mt-5" /> : null}
    </div>
  );
}

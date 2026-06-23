"use client";

import { useEffect, useState } from "react";

export const veraThinkingMessages = [
  "Searching reviews and discussions...",
  "Finding what people agree on...",
  "Checking for disagreement...",
  "Comparing recommendations...",
  "Measuring consensus...",
  "Building the final result..."
];

export function VeraThinking({ className = "" }: { className?: string }) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setMessageIndex((index) => (index + 1) % veraThinkingMessages.length);
    }, 1500);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className={`flex justify-center ${className}`} aria-live="polite">
      <div className="inline-flex items-center gap-3 rounded-full border border-line/80 bg-white/85 px-4 py-2.5 text-muted shadow-[0_14px_44px_rgba(0,0,0,0.045)] backdrop-blur">
      <div className="vera-orb" aria-hidden="true">
        <span />
      </div>
      <p className="min-w-[17rem] text-left text-[15px] font-medium leading-7 text-[#62626A] transition-opacity duration-500">
        {veraThinkingMessages[messageIndex]}
      </p>
      </div>
    </div>
  );
}

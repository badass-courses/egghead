"use client";

import { useEffect, useRef, useState } from "react";

export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  return (
    <button
      aria-label={copied ? "Copied" : "Copy code"}
      className="egghead-code-copy"
      data-copied={copied ? "" : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
        } catch {
          return;
        }
        setCopied(true);
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
      }}
      type="button"
    >
      {copied ? (
        <svg
          aria-hidden
          fill="none"
          height="12"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.5"
          viewBox="0 0 12 10"
          width="14"
        >
          <path d="M1.5 5.5L4.5 8.5L10.5 1.5" />
        </svg>
      ) : (
        <svg
          aria-hidden
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          viewBox="0 0 16 16"
          width="14"
        >
          <rect height="9.5" rx="2" width="9.5" x="5" y="5" />
          <path d="M11 2.5H4A2.5 2.5 0 0 0 1.5 5v7" />
        </svg>
      )}
    </button>
  );
}

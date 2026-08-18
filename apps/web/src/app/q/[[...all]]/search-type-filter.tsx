"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { searchHref } from "./search-href";

const SEARCH_TYPE_OPTIONS = [
  { label: "Courses", value: "course" },
  { label: "Lessons", value: "lesson" },
  { label: "Articles", value: "article" },
  { label: "Talks", value: "talk" },
  { label: "Podcasts", value: "podcast" },
  { label: "Tips", value: "tip" },
] as const;

function ChevronsUpDownIcon() {
  return (
    <svg
      aria-hidden
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.5"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function SearchTypeFilter({
  contentType,
  instructor,
  term,
}: {
  contentType?: string | undefined;
  instructor?: string | undefined;
  term?: string | undefined;
}) {
  const router = useRouter();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return () => {};

    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        // Closing unmounts any focused option — put keyboard users back on
        // the trigger instead of dropping focus to <body>.
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const selected = SEARCH_TYPE_OPTIONS.find((option) => option.value === contentType);

  function refine(value: string) {
    router.push(
      searchHref({
        // Re-selecting the active type clears the filter, like aihero's refinement list.
        contentType: value === contentType ? "" : value,
        instructor,
        term,
      }),
    );
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="egghead-search-filter" ref={rootRef}>
      <button
        ref={triggerRef}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        type="button"
      >
        <span>{selected ? selected.label : "All types"}</span>
        <ChevronsUpDownIcon />
      </button>
      {open ? (
        <>
          {/* A styled combobox popover — the native select the rule suggests
              is exactly what this component replaces. */}
          {/* oxlint-disable jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/prefer-tag-over-role */}
          <ul aria-label="Filter by type" id={listboxId} role="listbox">
            <li key="all" role="none">
              <button
                aria-selected={!selected}
                onClick={() => refine("")}
                role="option"
                type="button"
              >
                All types
                <span data-option-check={selected ? "hidden" : "visible"}>
                  <CheckIcon />
                </span>
              </button>
            </li>
            {SEARCH_TYPE_OPTIONS.map((option) => (
              <li key={option.value} role="none">
                <button
                  aria-selected={option.value === contentType}
                  onClick={() => refine(option.value)}
                  role="option"
                  type="button"
                >
                  {option.label}
                  <span data-option-check={option.value === contentType ? "visible" : "hidden"}>
                    <CheckIcon />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

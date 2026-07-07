"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { SearchInstructor } from "../../../content/instructors";
import { searchHref } from "./search-href";

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

function instructorsFromResponse(value: unknown): SearchInstructor[] {
  if (typeof value !== "object" || value === null || !("instructors" in value)) return [];
  const { instructors } = value;
  if (!Array.isArray(instructors)) return [];
  return instructors.filter(
    (entry: unknown): entry is SearchInstructor =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      typeof entry.name === "string" &&
      "resourceCount" in entry &&
      typeof entry.resourceCount === "number",
  );
}

export function SearchInstructorFilter({
  contentType,
  defaultInstructors,
  instructor,
  term,
}: {
  contentType?: string | undefined;
  defaultInstructors: SearchInstructor[];
  instructor?: string | undefined;
  term?: string | undefined;
}) {
  const router = useRouter();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [filterTerm, setFilterTerm] = useState("");
  const [matches, setMatches] = useState<SearchInstructor[]>(defaultInstructors);

  useEffect(() => {
    if (!open) return () => {};

    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    const query = filterTerm.trim();
    if (!query) {
      setMatches(defaultInstructors);
      return () => {};
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(`/api/instructors?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        setMatches(instructorsFromResponse(await response.json()));
      } catch {
        // Aborted or failed lookups keep the current list.
      }
    }, 200);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [filterTerm, defaultInstructors]);

  function toggleOpen() {
    setOpen((wasOpen) => {
      if (wasOpen) return false;
      setFilterTerm("");
      setMatches(defaultInstructors);
      return true;
    });
  }

  function refine(value: string) {
    router.push(
      searchHref({
        contentType,
        // Re-selecting the active instructor clears the filter.
        instructor: value === instructor ? "" : value,
        term,
      }),
    );
    setOpen(false);
  }

  return (
    <div className="egghead-search-filter" ref={rootRef}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={toggleOpen}
        type="button"
      >
        <span>{instructor || "Instructor"}</span>
        <ChevronsUpDownIcon />
      </button>
      {open ? (
        <div className="egghead-search-filter-panel">
          <input
            aria-label="Search instructors"
            // The panel exists to be typed in the moment it opens.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(event) => setFilterTerm(event.currentTarget.value)}
            placeholder="Search instructors"
            type="search"
            value={filterTerm}
          />
          {/* A styled combobox popover — the native select/datalist the rule
              suggests is exactly what this component replaces. */}
          {/* oxlint-disable jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/prefer-tag-over-role */}
          <ul aria-label="Filter by instructor" id={listboxId} role="listbox">
            {instructor ? (
              <li key="all" role="none">
                <button
                  aria-selected={false}
                  onClick={() => refine("")}
                  role="option"
                  type="button"
                >
                  All instructors
                  <span data-option-check="hidden">
                    <CheckIcon />
                  </span>
                </button>
              </li>
            ) : null}
            {matches.map((match) => (
              <li key={match.name} role="none">
                <button
                  aria-selected={match.name === instructor}
                  onClick={() => refine(match.name)}
                  role="option"
                  type="button"
                >
                  {match.name}
                  <span data-option-check={match.name === instructor ? "visible" : "hidden"}>
                    <CheckIcon />
                  </span>
                </button>
              </li>
            ))}
            {matches.length === 0 ? (
              <li className="egghead-search-filter-empty">No instructors found.</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

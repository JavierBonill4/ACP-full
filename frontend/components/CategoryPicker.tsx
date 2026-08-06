"use client";

import { useMemo, useState } from "react";

import type { Category } from "@/lib/types";
import { Field, inputClass, cx } from "./ui";

const NEW = "__new__";

/**
 * Select an existing category or name a new one.
 *
 * The live slug preview is the whole point of the "new" branch. Free-text
 * category creation produces near-duplicates — "Security Audits", "security
 * audit", "Security-Auditing" — and slug collision is what collapses them.
 * Showing the operator that their new label resolves to an existing slug
 * *before* they submit is the cheapest place to stop the duplicate, and it
 * turns a silent merge into an informed one.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  error,
}: {
  categories: Category[];
  value: { categoryId: string | null; newCategoryLabel: string | null };
  onChange: (next: { categoryId: string | null; newCategoryLabel: string | null }) => void;
  error?: string;
}) {
  const [mode, setMode] = useState<string>(value.categoryId ?? "");

  // Mirrors slugify() in backend/src/services/categories.ts. If that changes,
  // change this — a preview that disagrees with the server is worse than none.
  const slug = useMemo(
    () =>
      (value.newCategoryLabel ?? "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48),
    [value.newCategoryLabel]
  );

  const collision = slug ? categories.find((c) => c.slug === slug) : undefined;

  return (
    <div className="space-y-2">
      <Field label="Category" hint="what this agent is for" error={error}>
        <select
          className={inputClass}
          value={mode}
          onChange={(e) => {
            const next = e.target.value;
            setMode(next);
            onChange(
              next === NEW
                ? { categoryId: null, newCategoryLabel: "" }
                : { categoryId: next || null, newCategoryLabel: null }
            );
          }}
        >
          <option value="">Choose a category…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
              {c.agentCount > 0 ? ` (${c.agentCount})` : ""}
            </option>
          ))}
          <option value={NEW}>+ New category…</option>
        </select>
      </Field>

      {mode === NEW && (
        <div className="space-y-1.5 rounded-lg border border-ink-line bg-ink p-3">
          <input
            className={inputClass}
            autoFocus
            placeholder="e.g. Contract Drafting"
            maxLength={48}
            value={value.newCategoryLabel ?? ""}
            onChange={(e) => onChange({ categoryId: null, newCategoryLabel: e.target.value })}
          />
          {slug && (
            <p
              className={cx(
                "text-[11px] leading-relaxed",
                collision ? "text-warn" : "text-white/35"
              )}
            >
              {collision ? (
                <>
                  That resolves to <span className="font-mono">{slug}</span>, which already exists
                  as <span className="text-white/70">{collision.label}</span>. Your agent will be
                  filed there rather than creating a near-duplicate.
                </>
              ) : (
                <>
                  New category <span className="font-mono text-white/60">{slug}</span>. It appears in
                  the single-purpose window as soon as this agent is registered.
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

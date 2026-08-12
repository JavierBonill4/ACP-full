"use client";

import { type ReactElement, useEffect, useMemo, useState } from "react";

/**
 * Renders a deliverable markdown deck as slides instead of a text dump.
 *
 * The research agent's `assemble()` wraps every deck the same way: a title
 * slide, `---`-separated content slides, then a provenance slide. This
 * component doesn't know or care how many slides are in the middle — it
 * splits on any line that is just `---` and renders each piece. That means
 * it degrades gracefully for a plain job.text with no `---` in it at all: it
 * just becomes a single "slide," which is exactly the old `<pre>` behavior
 * with nicer typography.
 */

interface SlideDeckProps {
  markdown: string;
}

function splitSlides(markdown: string): string[] {
  const slides = markdown
    .split(/\r?\n[ \t]*---[ \t]*\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return slides.length > 0 ? slides : [markdown.trim()];
}

/**
 * Minimal, deliberately non-exhaustive markdown renderer. This deck is
 * agent-generated but always our own agent's output shape (headings, bold,
 * italics, bullet/numbered lists, blockquotes, paragraphs) — it doesn't need
 * to handle arbitrary markdown, just needs to not choke on it.
 */
function renderInline(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function SlideBody({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);
  const blocks: ReactElement[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] | null = null;

  const flushList = (key: string) => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag
        key={key}
        className={list.ordered ? "list-decimal pl-6 space-y-1" : "list-disc pl-6 space-y-1"}
      >
        {list.items.map((item, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
        ))}
      </Tag>
    );
    list = null;
  };

  const flushQuote = (key: string) => {
    if (!quote) return;
    blocks.push(
      <blockquote
        key={key}
        className="border-l-2 border-neutral-300 pl-4 italic text-neutral-600"
        dangerouslySetInnerHTML={{ __html: renderInline(quote.join(" ")) }}
      />
    );
    quote = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    const key = `l${i}`;

    if (line === "") {
      flushList(key);
      flushQuote(key);
      return;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushList(key);
      flushQuote(key);
      const level = h[1].length;
      const sizes = ["text-3xl", "text-2xl", "text-xl", "text-lg"];
      const cls = `${sizes[Math.min(level - 1, 3)]} font-semibold tracking-tight mb-2`;
      blocks.push(<div key={key} className={cls} dangerouslySetInnerHTML={{ __html: renderInline(h[2]) }} />);
      return;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushQuote(key);
      if (!list || list.ordered) {
        flushList(key);
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
      return;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushQuote(key);
      if (!list || !list.ordered) {
        flushList(key);
        list = { ordered: true, items: [] };
      }
      list.items.push(numbered[1]);
      return;
    }

    if (line.startsWith(">")) {
      flushList(key);
      quote = [...(quote ?? []), line.replace(/^>\s?/, "")];
      return;
    }

    flushList(key);
    flushQuote(key);
    blocks.push(
      <p key={key} className="leading-relaxed text-neutral-800" dangerouslySetInnerHTML={{ __html: renderInline(line) }} />
    );
  });

  flushList("end-list");
  flushQuote("end-quote");

  return <div className="space-y-3">{blocks}</div>;
}

export default function SlideDeck({ markdown }: SlideDeckProps) {
  const slides = useMemo(() => splitSlides(markdown), [markdown]);
  const [index, setIndex] = useState(0);
  const clamped = Math.min(index, slides.length - 1);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, slides.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length]);

  return (
    <div className="w-full">
      <div className="rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="min-h-[280px] px-8 py-8">
          <SlideBody markdown={slides[clamped]} />
        </div>

        <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-2.5">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(i - 1, 0))}
            disabled={clamped === 0}
            className="rounded-md px-2.5 py-1 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ← Prev
          </button>

          <div className="flex items-center gap-1.5">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Slide ${i + 1}`}
                onClick={() => setIndex(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === clamped ? "w-4 bg-neutral-800" : "w-1.5 bg-neutral-300 hover:bg-neutral-400"
                }`}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(i + 1, slides.length - 1))}
            disabled={clamped === slides.length - 1}
            className="rounded-md px-2.5 py-1 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            Next →
          </button>
        </div>
      </div>

      <div className="mt-1.5 text-right text-xs text-neutral-400">
        {clamped + 1} / {slides.length}
      </div>
    </div>
  );
}

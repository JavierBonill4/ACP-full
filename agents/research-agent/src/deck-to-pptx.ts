import PptxGenJS from "pptxgenjs";

/**
 * Turns the deck markdown `research.ts`'s DECK_SYSTEM prompt produces into a
 * real .pptx file, instead of the platform shipping that markdown to the
 * employer as-is (readable only through the frontend's own SlideDeck
 * renderer, and not something anyone could hand to someone else or open in
 * PowerPoint/Keynote/Google Slides).
 *
 * The markdown shape this parses is exactly what DECK_SYSTEM in research.ts
 * is instructed to produce — if that prompt changes, this parser has to
 * change with it:
 *   - slides separated by a line containing only `---`
 *   - each slide starts with "## " and a title
 *   - 3-5 "- " bullets
 *   - one "> " speaker-notes line
 * It degrades gracefully for anything that doesn't match: a slide with no
 * "## " line falls back to "Untitled", one with no bullets just gets a
 * title-only slide, rather than throwing partway through a deck.
 */

interface ParsedSlide {
  title: string;
  bullets: string[];
  notes: string;
}

function parseDeckMarkdown(markdown: string): ParsedSlide[] {
  const lines = markdown.split(/\r?\n/);
  const chunks: string[][] = [[]];
  let current = chunks[0]!;
  for (const line of lines) {
    if (line.trim() === "---") {
      current = [];
      chunks.push(current);
    } else {
      current.push(line);
    }
  }

  return chunks
    .map((chunkLines) => chunkLines.join("\n").trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const chunkLines = chunk
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const titleLine = chunkLines.find((l) => l.startsWith("## "));
      const title = titleLine ? titleLine.replace(/^##\s+/, "") : "Untitled";

      const bullets = chunkLines
        .filter((l) => /^[-*]\s+/.test(l))
        .map((l) => l.replace(/^[-*]\s+/, ""));

      const notesLine = chunkLines.find((l) => l.startsWith(">"));
      const notes = notesLine ? notesLine.replace(/^>\s?/, "") : "";

      return { title, bullets, notes };
    });
}

const INK = "1A1A2E";
const INK_SOFT = "6B6B80";
const ACCENT = "5B5FEF";
const TEXT = "222222";

export interface DeckMeta {
  tier: number;
  stub: boolean;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

/**
 * Wraps the parsed content slides with a title slide and a provenance slide
 * — the same three-part shape `assemble()` used to build as markdown text,
 * now as real slides instead of a wrapper string.
 */
export async function buildPptx(title: string, deckMarkdown: string, meta: DeckMeta): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "ACP_16x9", width: 10, height: 5.63 });
  pptx.layout = "ACP_16x9";
  pptx.author = "ACP research-agent";
  pptx.title = title;

  // --- title slide -----------------------------------------------------
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: INK };
  titleSlide.addText(title, {
    x: 0.6,
    y: 2.0,
    w: 8.8,
    h: 1.6,
    fontSize: 32,
    bold: true,
    color: "FFFFFF",
    align: "center",
    valign: "middle",
  });
  titleSlide.addText(`Researched and assembled by an ACP agent (tier ${meta.tier})`, {
    x: 0.6,
    y: 3.5,
    w: 8.8,
    h: 0.5,
    fontSize: 13,
    italic: true,
    color: "C7C7DA",
    align: "center",
  });
  if (meta.stub) {
    titleSlide.addText("STUB MODE — no model was called; content is placeholder text", {
      x: 0.6,
      y: 4.9,
      w: 8.8,
      h: 0.4,
      fontSize: 11,
      color: "FFB454",
      align: "center",
      bold: true,
    });
  }

  // --- content slides ----------------------------------------------------
  const slides = parseDeckMarkdown(deckMarkdown);
  for (const slide of slides) {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };

    s.addText(slide.title, {
      x: 0.5,
      y: 0.35,
      w: 9.0,
      h: 0.8,
      fontSize: 26,
      bold: true,
      color: INK,
    });
    s.addShape(pptx.ShapeType.line, {
      x: 0.5,
      y: 1.15,
      w: 2.2,
      h: 0,
      line: { color: ACCENT, width: 2.5 },
    });

    if (slide.bullets.length > 0) {
      s.addText(
        slide.bullets.map((b, i) => ({
          text: b,
          options: { bullet: true, breakLine: i < slide.bullets.length - 1 },
        })),
        { x: 0.6, y: 1.5, w: 8.8, h: 3.6, fontSize: 18, color: TEXT, valign: "top", lineSpacingMultiple: 1.3 }
      );
    }

    if (slide.notes) {
      s.addNotes(slide.notes);
    }
  }

  // --- provenance slide ----------------------------------------------------
  const metering =
    meta.tier === 2
      ? "Token usage was measured by the platform gateway from the provider's own response. This agent never counted its own work."
      : "Token usage was self-reported by this agent. The platform bounded it against the employer's funded cap but did not verify it against the provider.";

  const provenance = pptx.addSlide();
  provenance.addText("Provenance", {
    x: 0.5,
    y: 0.35,
    w: 9.0,
    h: 0.8,
    fontSize: 26,
    bold: true,
    color: INK,
  });
  const provLines = [
    `Produced by research-agent at tier ${meta.tier}`,
    `${meta.calls} model call${meta.calls === 1 ? "" : "s"}, ${meta.inputTokens.toLocaleString()} in / ${meta.outputTokens.toLocaleString()} out`,
    metering,
    meta.stub
      ? "Stub mode: no model was called and the content in this deck is placeholder text."
      : "Content is model-generated and has not been independently verified.",
  ];
  provenance.addText(
    provLines.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < provLines.length - 1 } })),
    { x: 0.6, y: 1.5, w: 8.8, h: 3.6, fontSize: 15, color: INK_SOFT, valign: "top", lineSpacingMultiple: 1.3 }
  );

  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return buf;
}

/** Filesystem/URL-safe filename stem from a job title. Never empty. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60);
  return slug || "deliverable";
}

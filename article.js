// Fetch an article URL and extract its readable body text.
// Uses Mozilla Readability (the engine behind Firefox Reader Mode) over jsdom.
// Returns null when the page cannot be fetched or no article body is found.

import { JSDOM, VirtualConsole } from "jsdom";
import { Readability, isProbablyReaderable } from "@mozilla/readability";

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

// Skip clearly non-article targets (media files, PDFs, etc.)
const SKIP_EXTENSIONS = /\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mp3|avi|mov)(\?|#|$)/i;

function normalizeWhitespace(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch an article and return its main body text.
 * @param {string} url
 * @returns {Promise<string|null>} Extracted text, or null on failure.
 */
export async function fetchArticleText(url) {
  if (!url || typeof url !== "string") return null;
  if (!/^https?:\/\//i.test(url)) return null;
  if (SKIP_EXTENSIONS.test(url)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; my-news-alert-bot/1.0; +https://github.com/itukikikuti/my-news-alert-bot)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      console.warn(`[ARTICLE] HTTP ${res.status} for ${url}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) {
      console.warn(`[ARTICLE] Non-HTML content (${contentType}) for ${url}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_HTML_BYTES) {
      console.warn(`[ARTICLE] Page too large (${buf.byteLength} bytes) for ${url}`);
      return null;
    }
    html = new TextDecoder("utf-8").decode(buf);
  } catch (e) {
    console.warn(`[ARTICLE] Fetch failed for ${url}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  try {
    const virtualConsole = new VirtualConsole(); // swallow jsdom script errors
    const dom = new JSDOM(html, { url, virtualConsole });
    const doc = dom.window.document;

    // Readability works best when the page looks like an article; fall back to
    // it anyway if the heuristic is unsure, since we have no better option.
    if (!isProbablyReaderable(doc)) {
      console.warn(`[ARTICLE] Page may not be an article, attempting anyway: ${url}`);
    }

    const article = new Readability(doc).parse();
    const text = normalizeWhitespace(article?.textContent);
    if (!text) {
      console.warn(`[ARTICLE] No article body extracted for ${url}`);
      return null;
    }
    return text;
  } catch (e) {
    console.warn(`[ARTICLE] Extraction failed for ${url}: ${e.message}`);
    return null;
  }
}

import type { Platform } from "@prisma/client";

/** Pure URL parsers shared by the real adapters and the MockAdapter. */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const IG_CODE = /^[A-Za-z0-9_-]{5,64}$/;

function safeUrl(raw: string): URL | null {
  try {
    const trimmed = raw.trim();
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

export function parseYouTubeUrl(raw: string): { platformPostId: string; isShortsUrl: boolean } | null {
  const url = safeUrl(raw);
  if (!url) return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  let isShortsUrl = false;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "music.youtube.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" && parts[1]) {
      id = parts[1];
      isShortsUrl = true;
    } else if (parts[0] === "watch") {
      id = url.searchParams.get("v");
    } else if ((parts[0] === "embed" || parts[0] === "live") && parts[1]) {
      id = parts[1];
    }
  }
  return id && YT_ID.test(id) ? { platformPostId: id, isShortsUrl } : null;
}

export function parseInstagramUrl(raw: string): { platformPostId: string } | null {
  const url = safeUrl(raw);
  if (!url) return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (host !== "instagram.com" && host !== "instagr.am") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  // /reel/{code}, /reels/{code}, /p/{code}, or /{username}/reel/{code}
  const idx = parts.findIndex((p) => p === "reel" || p === "reels" || p === "p");
  const code = idx >= 0 ? parts[idx + 1] : undefined;
  return code && IG_CODE.test(code) ? { platformPostId: code } : null;
}

export function parseXUrl(raw: string): { platformPostId: string } | null {
  const url = safeUrl(raw);
  if (!url) return null;
  const host = url.hostname.replace(/^www\.|^mobile\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;
  const match = /^\/[^/]+\/status\/(\d{5,25})/.exec(url.pathname);
  return match ? { platformPostId: match[1]! } : null;
}

export function detectPlatform(raw: string): Platform | null {
  if (parseYouTubeUrl(raw)) return "YOUTUBE";
  if (parseInstagramUrl(raw)) return "INSTAGRAM";
  if (parseXUrl(raw)) return "X";
  return null;
}

/** Dev-only: `?mock=botted_spike` on a submitted URL picks the MockAdapter scenario. */
export function mockScenarioFromUrl(raw: string): string | null {
  const url = safeUrl(raw);
  const value = url?.searchParams.get("mock");
  return value ? value.toUpperCase() : null;
}

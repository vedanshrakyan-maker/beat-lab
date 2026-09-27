import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { actorFor, getCurrentUser } from "@/lib/session";
import { completeYouTubeOAuth } from "@/domain/social-accounts";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (msg: string) =>
    NextResponse.redirect(new URL(`/clipper/accounts?yt=${encodeURIComponent(msg)}`, req.url));
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/signin", req.url));
  const jar = await cookies();
  const expected = jar.get("yt_oauth_state")?.value;
  jar.delete("yt_oauth_state");
  const code = url.searchParams.get("code");
  if (!code || !expected || url.searchParams.get("state") !== expected)
    return back("YouTube connection was cancelled or expired");
  try {
    await completeYouTubeOAuth(user.id, code, await actorFor(user));
    return back("connected");
  } catch (e) {
    return back(e instanceof Error ? e.message : "YouTube connection failed");
  }
}

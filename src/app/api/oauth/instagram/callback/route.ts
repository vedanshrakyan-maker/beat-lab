import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser, actorFor } from "@/lib/session";
import { completeInstagramOAuth } from "@/domain/social-accounts";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (msg: string) =>
    NextResponse.redirect(new URL(`/clipper/accounts?ig=${encodeURIComponent(msg)}`, req.url));
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/signin", req.url));
  const jar = await cookies();
  const expected = jar.get("ig_oauth_state")?.value;
  jar.delete("ig_oauth_state");
  const code = url.searchParams.get("code");
  if (!code || !expected || url.searchParams.get("state") !== expected)
    return back("Instagram connection was cancelled or expired");
  try {
    await completeInstagramOAuth(user.id, code, await actorFor(user));
    return back("connected");
  } catch (e) {
    return back(e instanceof Error ? e.message : "Instagram connection failed");
  }
}

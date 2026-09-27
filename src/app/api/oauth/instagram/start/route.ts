import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomToken } from "@/lib/crypto";
import { getCurrentUser } from "@/lib/session";
import { instagramAdapterLive, instagramRedirectUri } from "@/domain/social-accounts";

/** Start Instagram Login OAuth (live mode only; needs Meta app review for real users). */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user?.roles.includes("CLIPPER")) return NextResponse.redirect(new URL("/signin", req.url));
  const state = randomToken(16);
  (await cookies()).set("ig_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 600,
    path: "/",
  });
  return NextResponse.redirect(instagramAdapterLive().authorizeUrl(instagramRedirectUri(), state));
}

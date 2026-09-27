import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomToken } from "@/lib/crypto";
import { getCurrentUser } from "@/lib/session";
import { googleAuthorizeUrl } from "@/platforms/google-oauth";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user?.roles.includes("CLIPPER")) return NextResponse.redirect(new URL("/signin", req.url));
  const state = randomToken(16);
  (await cookies()).set("yt_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 600,
    path: "/",
  });
  return NextResponse.redirect(googleAuthorizeUrl(state));
}

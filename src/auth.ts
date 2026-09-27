import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type DefaultSession } from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { getEmailAdapter } from "@/lib/email";
import { devLoginEnabled, env } from "@/env";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

/**
 * Auth.js (NextAuth v5).
 * - Email magic link in every environment; in development the link is logged to the console.
 * - Dev-only "sign in as seeded user" switcher (Credentials provider), never in production.
 * Roles are NOT trusted from the session: every server action re-loads the user (src/lib/session.ts).
 */
const providers: Provider[] = [
  {
    id: "email",
    type: "email",
    name: "Email",
    from: env().EMAIL_FROM,
    maxAge: 24 * 60 * 60,
    async sendVerificationRequest({ identifier, url }) {
      if (env().APP_ENV !== "production")
        console.log(`\n🔗 Magic sign-in link for ${identifier}:\n   ${url}\n`);
      await getEmailAdapter().send({
        to: identifier,
        subject: "Your ReelPay sign-in link",
        text: `Sign in to ReelPay:\n${url}\n\nThis link expires in 24 hours. If you didn't request it, ignore this email.`,
      });
    },
  },
];

if (devLoginEnabled()) {
  providers.push(
    Credentials({
      id: "dev-login",
      name: "Dev login",
      credentials: { userId: { label: "User id", type: "text" } },
      async authorize(credentials) {
        if (!devLoginEnabled()) return null;
        const userId = typeof credentials?.userId === "string" ? credentials.userId : "";
        const user = await db.user.findUnique({ where: { id: userId } });
        return user ? { id: user.id, email: user.email, name: user.name } : null;
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  // JWT sessions (required for the dev Credentials provider); roles are always re-read from the DB.
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  pages: { signIn: "/signin", verifyRequest: "/signin?sent=1", error: "/signin" },
  providers,
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (typeof token.uid === "string") session.user.id = token.uid;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (user.id)
        await db.user
          .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
          .catch(() => undefined);
    },
  },
});

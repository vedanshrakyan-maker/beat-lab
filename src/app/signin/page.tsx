import { redirect } from "next/navigation";
import { AuthError as NextAuthError } from "next-auth";
import { signIn } from "@/auth";
import { devLoginEnabled } from "@/env";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

async function emailSignIn(form: FormData) {
  "use server";
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/signin?error=email");
  try {
    await signIn("email", { email, redirectTo: "/" });
  } catch (e) {
    if (e instanceof NextAuthError) redirect("/signin?error=send");
    throw e;
  }
}

async function devSignIn(form: FormData) {
  "use server";
  if (!devLoginEnabled()) redirect("/signin");
  const userId = String(form.get("userId") ?? "");
  const user = await db.user.findUnique({ where: { id: userId } });
  const home = user?.roles.includes("ADMIN")
    ? "/admin"
    : user?.roles.includes("FUNDER")
      ? "/funder"
      : "/clipper";
  await signIn("dev-login", { userId, redirectTo: home });
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  if (await getCurrentUser()) redirect("/");
  const dev = devLoginEnabled();
  const users = dev
    ? await db.user.findMany({
        orderBy: [{ createdAt: "asc" }],
        take: 40,
        select: { id: true, name: true, email: true, roles: true, flaggedAt: true },
      })
    : [];
  const groups: { label: string; users: typeof users }[] = [
    { label: "Admin", users: users.filter((u) => u.roles.includes("ADMIN")) },
    {
      label: "Funders",
      users: users.filter((u) => u.roles.includes("FUNDER") && !u.roles.includes("ADMIN")),
    },
    {
      label: "Clippers",
      users: users.filter(
        (u) => u.roles.includes("CLIPPER") && !u.roles.includes("FUNDER") && !u.roles.includes("ADMIN"),
      ),
    },
  ];

  return (
    <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
      <Card className="p-7">
        <h1 className="font-serif text-3xl">Sign in</h1>
        <p className="text-muted mt-2 text-sm">We&apos;ll email you a magic link. No passwords.</p>
        {params.sent ? (
          <p className="border-good/30 bg-good/10 text-good mt-6 rounded-xl border p-3 text-sm">
            Check your email for a sign-in link.
            {dev ? " In development the link is printed in the server console." : ""}
          </p>
        ) : (
          <form action={emailSignIn} className="mt-6 space-y-3">
            <Input name="email" type="email" required placeholder="you@example.com" autoComplete="email" />
            <Button type="submit" className="w-full">
              Email me a link
            </Button>
            {params.error ? (
              <p className="text-bad text-sm">
                Couldn&apos;t send the link. Check the address and try again.
              </p>
            ) : null}
          </form>
        )}
      </Card>
      {dev ? (
        <Card className="p-7">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-2xl">Dev switcher</h2>
            <Badge tone="warn">development only</Badge>
          </div>
          <p className="text-muted mt-2 text-sm">
            Sign in as a seeded user. Disabled when APP_ENV=production.
          </p>
          {users.length === 0 ? (
            <p className="text-muted mt-6 text-sm">
              No users yet — run <code>npm run db:seed</code>.
            </p>
          ) : null}
          <div className="mt-5 space-y-5">
            {groups.map((g) =>
              g.users.length ? (
                <div key={g.label}>
                  <div className="text-muted mb-2 text-xs tracking-wide uppercase">{g.label}</div>
                  <div className="flex flex-col gap-1.5">
                    {g.users.map((u) => (
                      <form key={u.id} action={devSignIn}>
                        <input type="hidden" name="userId" value={u.id} />
                        <button
                          type="submit"
                          data-testid={`dev-login-${u.email}`}
                          className="border-border hover:border-accent flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm"
                        >
                          <span>
                            {u.name} <span className="text-muted">· {u.email}</span>
                          </span>
                          {u.flaggedAt ? <Badge tone="bad">flagged</Badge> : null}
                        </button>
                      </form>
                    ))}
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

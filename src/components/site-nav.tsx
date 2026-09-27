import Link from "next/link";
import { signOut } from "@/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { t } from "@/i18n";
import { Badge } from "@/components/ui/badge";

export async function SiteNav() {
  const user = await getCurrentUser().catch(() => null);
  const unread = user ? await db.notification.count({ where: { userId: user.id, readAt: null } }) : 0;
  const links: { href: string; label: string }[] = [{ href: "/campaigns", label: t("nav.campaigns") }];
  if (user?.roles.includes("CLIPPER")) links.push({ href: "/clipper", label: t("nav.clipper") });
  if (user?.roles.includes("FUNDER")) links.push({ href: "/funder", label: t("nav.funder") });
  if (user?.roles.includes("ADMIN")) links.push({ href: "/admin", label: t("nav.admin") });

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <header className="border-border bg-bg/85 sticky top-0 z-20 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 md:px-8">
        <Link href="/" className="font-serif text-lg tracking-tight">
          Reel<span className="text-accent">Pay</span>
        </Link>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto text-sm">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-muted hover:bg-surface-2 hover:text-fg rounded-full px-3 py-1.5"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        {user ? (
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/notifications"
              className="text-muted hover:text-fg relative rounded-full px-2 py-1.5"
              aria-label={t("nav.notifications")}
            >
              🔔
              {unread > 0 ? (
                <Badge tone="accent" className="ml-1 px-1.5 py-0">
                  {unread}
                </Badge>
              ) : null}
            </Link>
            <span className="text-muted hidden max-w-40 truncate md:inline">{user.name ?? user.email}</span>
            <form action={doSignOut}>
              <button className="text-muted hover:bg-surface-2 hover:text-fg rounded-full px-3 py-1.5">
                {t("nav.signOut")}
              </button>
            </form>
          </div>
        ) : (
          <Link
            href="/signin"
            className="bg-accent text-accent-fg rounded-full px-4 py-1.5 text-sm font-medium"
          >
            {t("nav.signIn")}
          </Link>
        )}
      </div>
    </header>
  );
}

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { Empty, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { requirePageUser, requireUser } from "@/lib/session";
import { timeAgo } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

async function markAllRead() {
  "use server";
  const user = await requireUser();
  await db.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/notifications");
}

export default async function NotificationsPage() {
  const user = await requirePageUser();
  const items = await db.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Notifications"
        actions={
          <form action={markAllRead}>
            <Button variant="secondary" size="sm">
              Mark all read
            </Button>
          </form>
        }
      />
      {items.length === 0 ? <Empty>You&apos;re all caught up.</Empty> : null}
      <ul className="space-y-2">
        {items.map((n) => {
          const body = (
            <div
              className={`rounded-2xl border p-4 ${n.readAt ? "border-border bg-surface" : "border-accent/40 bg-accent/5"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{n.title}</span>
                <span className="text-muted text-xs">{timeAgo(n.createdAt)}</span>
              </div>
              <p className="text-muted mt-1 text-sm">{n.body}</p>
            </div>
          );
          return <li key={n.id}>{n.href ? <Link href={n.href}>{body}</Link> : body}</li>;
        })}
      </ul>
    </div>
  );
}

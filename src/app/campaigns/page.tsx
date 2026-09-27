import { CampaignCard } from "@/components/campaign-card";
import { Empty, PageHeader } from "@/components/page";
import { publicCampaigns } from "@/domain/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaigns" };

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const { platform } = await searchParams;
  const all = await publicCampaigns();
  const campaigns = platform ? all.filter((c) => c.allowedPlatforms.includes(platform as never)) : all;
  const filters = [
    { label: "All", href: "/campaigns", active: !platform },
    { label: "Instagram Reels", href: "/campaigns?platform=INSTAGRAM", active: platform === "INSTAGRAM" },
    { label: "YouTube Shorts", href: "/campaigns?platform=YOUTUBE", active: platform === "YOUTUBE" },
  ];
  return (
    <div>
      <PageHeader
        eyebrow="Earn per verified view"
        title="Campaigns"
        subtitle="Pick a campaign, post a clip on your own account, paste the link. Earn until the budget runs out."
      />
      <div className="mb-6 flex gap-2">
        {filters.map((f) => (
          <a
            key={f.href}
            href={f.href}
            className={`rounded-full border px-3 py-1 text-sm ${f.active ? "border-accent text-accent" : "border-border text-muted hover:text-fg"}`}
          >
            {f.label}
          </a>
        ))}
      </div>
      {campaigns.length === 0 ? (
        <Empty>No live campaigns right now. Check back soon.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((c) => (
            <CampaignCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

import { CampaignCard } from "@/components/campaign-card";
import { LinkButton } from "@/components/ui/button";
import { publicCampaigns } from "@/domain/queries";
import { t, type MessageKey } from "@/i18n";

export const dynamic = "force-dynamic";

export default async function Home() {
  const campaigns = (await publicCampaigns()).filter((c) => c.status === "ACTIVE").slice(0, 3);
  const steps = (prefix: string) => [1, 2, 3].map((i) => t(`${prefix}.${i}` as MessageKey));
  return (
    <div>
      <section className="py-10 md:py-20">
        <div className="text-accent mb-6 text-xs tracking-[0.25em] uppercase">
          Instagram Reels · YouTube Shorts · UPI payouts
        </div>
        <h1 className="max-w-4xl font-serif text-5xl leading-[1.05] md:text-7xl">
          {t("landing.hero.title")}
        </h1>
        <p className="text-muted mt-6 max-w-2xl text-lg">{t("landing.hero.subtitle")}</p>
        <div className="mt-10 flex flex-wrap gap-3">
          <LinkButton href="/campaigns" size="lg">
            {t("landing.cta.browse")}
          </LinkButton>
          <LinkButton href="/funder/campaigns/new" size="lg" variant="outline">
            {t("landing.cta.fund")}
          </LinkButton>
        </div>
      </section>

      <section className="border-border grid gap-4 border-t py-12 md:grid-cols-2">
        {[
          { title: t("landing.funders.title"), items: steps("landing.funders") },
          { title: t("landing.clippers.title"), items: steps("landing.clippers") },
        ].map((col) => (
          <div key={col.title} className="border-border bg-surface rounded-2xl border p-6">
            <h2 className="font-serif text-2xl">{col.title}</h2>
            <ol className="mt-5 space-y-4">
              {col.items.map((item, i) => (
                <li key={i} className="flex gap-4">
                  <span className="tabular text-accent font-serif text-2xl">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-muted pt-1">{item}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      <section className="border-accent/30 bg-accent/5 rounded-3xl border p-8 md:p-12">
        <div className="text-accent text-xs tracking-[0.25em] uppercase">Our promise</div>
        <h2 className="mt-3 font-serif text-3xl md:text-4xl">{t("landing.fraud.title")}</h2>
        <p className="text-muted mt-4 max-w-3xl">{t("landing.fraud.body")}</p>
        <blockquote className="border-accent mt-6 max-w-3xl border-l-2 pl-4 font-serif text-lg italic">
          “Views jumped 69,100 in 2h (97% of all views), then grew only 1.3% over the next 21h — the pattern
          of purchased views.”
        </blockquote>
        <p className="text-muted mt-2 text-xs">
          A real explanation from our fraud engine, shown to funders on every blocked payout.
        </p>
      </section>

      {campaigns.length > 0 ? (
        <section className="py-12">
          <h2 className="mb-6 font-serif text-2xl">Live campaigns</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {campaigns.map((c) => (
              <CampaignCard key={c.id} c={c} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

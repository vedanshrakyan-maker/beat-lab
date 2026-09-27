import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteNav } from "@/components/site-nav";
import { t } from "@/i18n";

export const metadata: Metadata = {
  title: { default: `${t("app.name")} — ${t("app.tagline")}`, template: `%s · ${t("app.name")}` },
  description: t("landing.hero.subtitle"),
};

export const viewport: Viewport = { themeColor: "#0a0a0a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <SiteNav />
        <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-24 md:px-8 md:pt-10">{children}</main>
        <footer className="border-border text-muted border-t py-8 text-center text-xs">
          {t("app.name")} v0.1 prototype · Mock integrations in development · Not financial or tax advice
        </footer>
      </body>
    </html>
  );
}

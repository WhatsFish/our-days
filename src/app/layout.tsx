import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "拾光 · 私人来信",
  description: "把平凡的日子，慢慢收藏。",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const src = process.env.NEXT_PUBLIC_UMAMI_SRC, id = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  return <html lang="zh-CN"><body>
    {children}
    {src && id && <Script src={src} data-website-id={id} data-auto-track="false" strategy="afterInteractive" />}
  </body></html>;
}

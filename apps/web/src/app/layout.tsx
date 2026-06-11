import type { Metadata } from "next";
import { Caveat, Varela_Round } from "next/font/google";
import { Suspense } from "react";

import "@egghead/ui/globals.css";
import "./components.css";

import { SiteFooter } from "./site-footer";
import { SiteNav, SiteNavView } from "./site-nav";

const varelaRound = Varela_Round({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-varela",
});

const caveat = Caveat({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-caveat",
});

export const metadata: Metadata = {
  title: "egghead",
  description: "Courses, lessons, articles, talks, podcasts, and field notes for developers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html className={`${varelaRound.variable} ${caveat.variable}`} id="top" lang="en">
      <body>
        <Suspense fallback={<SiteNavView pathname={null} />}>
          <SiteNav />
        </Suspense>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}

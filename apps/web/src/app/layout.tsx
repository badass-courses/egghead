import type { Metadata } from "next";
import { Caveat, Nunito } from "next/font/google";
import { Suspense } from "react";

import "@egghead/ui/globals.css";
import "./components.css";

import { SiteFooter } from "./site-footer";
import { SiteNavView } from "./site-nav";
import { SiteNavWithAccount } from "./site-nav-with-account";

const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-nunito",
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
    <html className={`${nunito.variable} ${caveat.variable}`} id="top" lang="en">
      <head>
        <link href="https://image.mux.com" rel="preconnect" />
        <link href="https://stream.mux.com" rel="preconnect" />
      </head>
      <body>
        <Suspense fallback={<SiteNavView accountState="unknown" pathname={null} />}>
          <SiteNavWithAccount />
        </Suspense>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}

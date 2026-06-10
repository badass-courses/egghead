import type { Metadata } from "next";
import "@egghead/ui/styles.css";
import "./globals.css";

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
    <html lang="en">
      <head>
        <link href="https://image.mux.com" rel="preconnect" />
        <link href="https://stream.mux.com" rel="preconnect" />
      </head>
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "@egghead/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "egghead",
  description: "Standalone Egghead CourseBuilder app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

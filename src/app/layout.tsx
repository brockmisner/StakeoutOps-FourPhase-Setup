import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Stakeout Ops — DuoPlus scheduling",
  description: "Schedule, dispatch, and monitor DuoPlus RPA work across every client.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

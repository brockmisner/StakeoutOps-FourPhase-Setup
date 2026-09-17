import type { Metadata } from "next";

import "./globals.css";
import "./premium.css";

export const metadata: Metadata = {
  title: "Stakeout Ops — Fleet command center",
  description: "Schedule, dispatch, and monitor DuoPlus RPA work across every client.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

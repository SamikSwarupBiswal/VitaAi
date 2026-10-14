import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VitaAi | Account Intelligence",
  description: "Evidence-backed account intelligence and governed action preparation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth"><body>{children}</body></html>;
}

import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { readThemeCookie } from "@/lib/auth";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ledgerline",
  description: "Credit card balances, checking account, and the month ahead.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // "system" leaves the attribute off so the OS preference applies.
  const theme = await readThemeCookie();
  return (
    <html
      lang="en"
      data-theme={theme === "system" ? undefined : theme}
      className={`${archivo.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

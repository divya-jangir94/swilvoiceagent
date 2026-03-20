import "./globals.css";
import type { Metadata } from "next";
import React from "react";

export const metadata: Metadata = {
  title: "SWIL Voice Support",
  description: "SWIL Support voice assistant",
  icons: { icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎙️</text></svg>" },
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  // Root layout wraps the entire application and applies base theming.
  return (
    <html lang="en">
      <body className="h-screen bg-[#080B18] text-slate-50 antialiased">
        <div className="flex h-screen items-center justify-center p-4">
          {children}
        </div>
      </body>
    </html>
  );
}


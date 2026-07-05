import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexra AI",
  description: "Focused AI products for clearer decisions."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

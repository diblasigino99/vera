import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vera",
  description: "Discover what the internet agrees on for your specific situation."
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

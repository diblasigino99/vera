import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.nexraai.com"),
  title: "Nexra AI",
  description: "Focused AI products for clearer decisions.",
  openGraph: {
    title: "Nexra AI",
    description: "Focused AI products for clearer decisions.",
    url: "https://www.nexraai.com",
    siteName: "Nexra AI",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Nexra AI"
      }
    ],
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Nexra AI",
    description: "Focused AI products for clearer decisions.",
    images: ["/opengraph-image"]
  }
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

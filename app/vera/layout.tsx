import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vera",
  description: "See where the internet agrees—and where it doesn't.",
  openGraph: {
    title: "Vera",
    description: "See where the internet agrees—and where it doesn't.",
    url: "https://www.nexraai.com/vera",
    siteName: "Vera",
    images: [
      {
        url: "/vera/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Vera"
      }
    ],
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Vera",
    description: "See where the internet agrees—and where it doesn't.",
    images: ["/vera/opengraph-image"]
  },
  icons: {
    icon: "/vera/icon.svg"
  }
};

export default function VeraLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}

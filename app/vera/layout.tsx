import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vera",
  description: "See where the internet agrees—and where it doesn't."
};

export default function VeraLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}

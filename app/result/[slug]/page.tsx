import { redirect } from "next/navigation";
import type { Route } from "next";

type LegacyResultPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export default async function LegacyResultPage({ params }: LegacyResultPageProps) {
  const { slug } = await params;

  redirect(`/vera/result/${slug}` as Route);
}

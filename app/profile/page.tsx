import Link from "next/link";
import { ProfileView } from "@/components/profile-view";

export default function ProfilePage() {
  return (
    <main className="min-h-screen bg-white px-5 py-8">
      <nav className="mx-auto flex w-full max-w-5xl items-center justify-between">
        <Link href="/" className="font-serif text-3xl text-ink">
          Vera
        </Link>
        <Link href="/" className="text-sm text-muted transition hover:text-ink">
          Search
        </Link>
      </nav>
      <ProfileView />
    </main>
  );
}

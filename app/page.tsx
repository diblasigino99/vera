import Link from "next/link";

export default function NexraHome() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-5 py-16 text-center">
      <section className="mx-auto max-w-2xl">
        <p className="text-sm font-medium uppercase tracking-[0.24em] text-[#9B9BA3]">Nexra AI</p>
        <h1 className="mt-6 font-serif text-6xl leading-none tracking-[-0.045em] text-[#111114] sm:text-7xl">Nexra AI</h1>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-[#62626A]">
          Building focused AI products for people who want clearer answers.
        </p>
        <Link
          href="/vera"
          className="mt-9 inline-flex rounded-full bg-[#111114] px-5 py-3 text-sm font-medium text-white shadow-[0_12px_30px_rgba(17,17,20,0.16)] transition hover:bg-[#2C2C30]"
        >
          Open Vera
        </Link>
        <footer className="mt-8 flex items-center justify-center gap-5 text-xs text-[#A6A6AD]">
          <Link href="/privacy" className="transition hover:text-[#62626A]">
            Privacy Policy
          </Link>
          <Link href="/terms" className="transition hover:text-[#62626A]">
            Terms of Service
          </Link>
        </footer>
      </section>
    </main>
  );
}

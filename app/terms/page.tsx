import Link from "next/link";

const sections = [
  {
    title: "What Vera Provides",
    body: [
      "Vera provides informational consensus-based search results. It summarizes public sources, reviews, discussions, and other available evidence to help you make decisions.",
      "Vera is not a professional advisor and does not replace your own judgment."
    ]
  },
  {
    title: "Results May Be Imperfect",
    body: [
      "Vera's results may occasionally be incomplete, outdated, inconsistent, or incorrect.",
      "You remain responsible for your own decisions, purchases, travel plans, and other actions based on Vera's results."
    ]
  },
  {
    title: "Acceptable Use",
    body: [
      "Do not use Vera to break the law, abuse the service, reverse engineer private systems, overload infrastructure, or harm others.",
      "Do not submit content that is illegal, abusive, or intended to interfere with Vera's operation."
    ]
  },
  {
    title: "Intellectual Property",
    body: [
      "Vera, Nexra AI, and the product design, interface, and underlying systems belong to Nexra AI.",
      "You may use Vera's results for personal decision-making, but you may not copy or resell the service as your own product."
    ]
  },
  {
    title: "Feedback",
    body: [
      "If you submit feedback, you allow Nexra AI to use it to improve Vera, including search quality, product reliability, and user experience.",
      "Please do not include sensitive personal information in feedback."
    ]
  },
  {
    title: "Service Availability",
    body: [
      "Vera may change, pause, or become unavailable at times. We try to keep the service reliable, but availability is not guaranteed."
    ]
  },
  {
    title: "Limitation Of Liability",
    body: [
      "To the fullest extent allowed by law, Nexra AI is not liable for losses or damages arising from your use of Vera or reliance on its results."
    ]
  },
  {
    title: "Contact",
    body: ["Questions about these terms can be sent to hello@nexraai.com."]
  }
];

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white px-5 py-8 text-[#111114]">
      <PolicyNav />
      <article className="mx-auto mt-16 max-w-3xl">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Vera</p>
        <h1 className="mt-5 font-serif text-5xl tracking-[-0.035em] sm:text-6xl">Terms of Service</h1>
        <p className="mt-5 text-sm text-[#8A8A92]">Last updated July 20, 2026</p>
        <p className="mt-8 text-xl leading-9 text-[#3B3B42]">
          These terms describe how Vera may be used and what to expect from an informational consensus product.
        </p>

        <div className="mt-14 grid gap-10">
          {sections.map((section) => (
            <section className="border-t border-[#ECECF0] pt-6" key={section.title}>
              <h2 className="text-2xl font-semibold tracking-[-0.02em]">{section.title}</h2>
              <div className="mt-4 grid gap-3 text-base leading-8 text-[#4B4B52]">
                {section.body.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}

function PolicyNav() {
  return (
    <nav className="mx-auto flex w-full max-w-5xl items-center justify-between">
      <Link href="/vera" className="font-serif text-3xl text-[#111114]">
        Vera
      </Link>
      <div className="flex gap-5 text-sm text-[#73737C]">
        <Link href="/privacy" className="transition hover:text-[#111114]">
          Privacy
        </Link>
        <Link href="/vera" className="transition hover:text-[#111114]">
          Search
        </Link>
      </div>
    </nav>
  );
}

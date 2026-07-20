import Link from "next/link";

const sections = [
  {
    title: "What Vera Collects",
    body: [
      "Search queries you submit to Vera.",
      "Anonymous usage analytics, such as response times, cache hits, result classifications, and error signals.",
      "Feedback submissions you choose to send, including optional text."
    ]
  },
  {
    title: "What Vera Does Not Collect",
    body: [
      "Payment information.",
      "Unnecessary personal information.",
      "Public profiles, followers, or social activity."
    ]
  },
  {
    title: "How Data Is Used",
    body: [
      "To improve search quality and identify weak or incorrect consensus results.",
      "To understand product usage, reliability, speed, and error patterns.",
      "To review feedback and make Vera more useful."
    ]
  },
  {
    title: "Search Data And Caching",
    body: [
      "Vera caches search results so repeated searches can return faster and avoid unnecessary external API calls.",
      "Cached results may include the query, the consensus result, sources, timings, and technical metadata used to operate the service."
    ]
  },
  {
    title: "Third-Party Services",
    body: [
      "Vera uses OpenAI for analysis, Tavily for web retrieval, Supabase for data storage, Vercel for hosting, and Google Places API for validating local businesses when applicable.",
      "These services may process data needed to provide Vera's results."
    ]
  },
  {
    title: "Data Security",
    body: [
      "Vera uses server-side access for private operational data and does not expose service-role credentials to the browser.",
      "No system can be guaranteed perfectly secure, but Vera is designed to keep operational data private and access-limited."
    ]
  },
  {
    title: "Contact",
    body: ["Questions or requests can be sent to hello@nexraai.com."]
  }
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white px-5 py-8 text-[#111114]">
      <PolicyNav />
      <article className="mx-auto mt-16 max-w-3xl">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-[#9B9BA3]">Vera</p>
        <h1 className="mt-5 font-serif text-5xl tracking-[-0.035em] sm:text-6xl">Privacy Policy</h1>
        <p className="mt-5 text-sm text-[#8A8A92]">Last updated July 20, 2026</p>
        <p className="mt-8 text-xl leading-9 text-[#3B3B42]">
          Vera is built to help people understand where the internet agrees. This policy explains the limited data Vera collects to operate and improve the product.
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
        <Link href="/terms" className="transition hover:text-[#111114]">
          Terms
        </Link>
        <Link href="/vera" className="transition hover:text-[#111114]">
          Search
        </Link>
      </div>
    </nav>
  );
}

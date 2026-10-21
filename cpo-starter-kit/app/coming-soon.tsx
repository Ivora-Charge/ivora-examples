import Link from "next/link";
import { moduleBySlug } from "@/lib/modules";
import { requireRole } from "@/lib/server/auth";

/** Placeholder for a section that a later part of the kit fills in. */
export default async function ComingSoon({ slug }: { slug: string }) {
  await requireRole("viewer");
  const m = moduleBySlug(slug);
  return (
    <>
      <h1>{m.label}</h1>
      <section className="card placeholder" aria-labelledby="soon-heading">
        <h2 id="soon-heading">
          <span className="badge">Coming soon</span>
        </h2>
        <p>{m.summary}</p>
        <p className="muted">
          This section is not built yet. <Link href="/">Back to Overview</Link>
        </p>
      </section>
    </>
  );
}

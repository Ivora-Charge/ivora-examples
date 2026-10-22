import Link from "next/link";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <section className="card state" aria-labelledby="nf-heading">
      <h1 id="nf-heading">Page not found</h1>
      <p>
        That page does not exist, or it is not turned on for this deployment.
      </p>
      <div className="actions">
        <Link className="button" href="/">
          Back to the overview
        </Link>
      </div>
    </section>
  );
}

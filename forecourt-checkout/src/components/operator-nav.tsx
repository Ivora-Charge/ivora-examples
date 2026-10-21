import Link from "next/link";

export function OperatorNav({
  current,
}: {
  current: "today" | "prices" | "faults";
}) {
  const item = (key: typeof current, href: string, label: string) =>
    key === current ? (
      <strong aria-current="page">{label}</strong>
    ) : (
      <Link href={href}>{label}</Link>
    );
  return (
    <nav className="operator" aria-label="Operator">
      {item("today", "/operator", "Today")}
      {item("prices", "/operator/prices", "Prices")}
      {item("faults", "/operator/faults", "Faults")}
      <Link href="/cashier">Cashier console</Link>
      <form action="/api/operator/logout" method="post">
        <button className="secondary" type="submit">
          Sign out
        </button>
      </form>
    </nav>
  );
}

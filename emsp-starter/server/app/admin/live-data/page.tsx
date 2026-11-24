import { redirect } from "next/navigation";

/** Live-data adapters moved to each peer's own page. */
export default function LiveDataPage() {
  redirect("/admin/peers");
}

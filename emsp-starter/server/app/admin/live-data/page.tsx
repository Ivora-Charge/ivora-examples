import { redirect } from "next/navigation";

/**
 * Live-data adapters moved: the list of all of them is on Peers, and each one is set,
 * replaced and removed on its peer's own page.
 */
export default function LiveDataPage() {
  redirect("/admin/peers#live-data");
}

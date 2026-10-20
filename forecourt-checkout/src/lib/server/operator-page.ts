import "server-only";
import { redirect } from "next/navigation";
import { isOperator } from "./auth";
import { settings } from "./services";

/** Every operator page starts here: no valid cookie, no data. */
export async function requireOperator() {
  const s = settings();
  if (!(await isOperator(s))) redirect("/operator/login");
  return s;
}

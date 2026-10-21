import "server-only";
import { redirect } from "next/navigation";
import { isCashier, isOperator } from "./auth";
import { settings } from "./services";

/** Every operator page starts here: no valid cookie, no data. */
export async function requireOperator() {
  const s = settings();
  if (!(await isOperator(s))) redirect("/operator/login");
  return s;
}

/** The cashier console: a cashier or operator cookie. */
export async function requireCashier() {
  const s = settings();
  if (!s.payInStore || !(await isCashier(s))) redirect("/cashier/login");
  return s;
}

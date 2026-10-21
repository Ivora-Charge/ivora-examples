import { cookies } from "next/headers";
import { SESSION_COOKIE, gate, isSignedIn } from "@/lib/auth";
import Board from "./board";
import Login from "./login";

export const dynamic = "force-dynamic";

export default async function Page() {
  const g = gate();
  if (g.mode === "missing")
    return (
      <main id="main">
        <h1>Setup needed</h1>
        <p className="warn" role="alert">
          {g.reason} Live mode can send charging profiles to real stations and
          block RFID cards, so it does not run without an operator password.
        </p>
      </main>
    );
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!isSignedIn(token)) return <Login />;
  return <Board signedIn={g.mode === "password"} />;
}

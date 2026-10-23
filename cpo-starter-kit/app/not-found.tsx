import { PublicHeader } from "./public-header";
import { NotFoundState } from "./states";

export const metadata = { title: "Page not found" };

/** An address no route matches: answered 404 outside the staff shell. */
export default function NotFound() {
  return (
    <>
      <PublicHeader />
      <main id="main" tabIndex={-1} className="public-main">
        <NotFoundState />
      </main>
    </>
  );
}

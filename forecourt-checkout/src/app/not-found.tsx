import Link from "next/link";
import { ErrorBox } from "@/components/error-box";

export default function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <ErrorBox
        info={{
          error: "not_found",
          message:
            "There is nothing at this address. Scan the QR code on the charger again, or start from the home page.",
        }}
      />
      <Link className="button block" href="/">
        Back to home
      </Link>
    </main>
  );
}

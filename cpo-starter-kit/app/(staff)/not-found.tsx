import { NotFoundState } from "../states";

export const metadata = { title: "Page not found" };

/** A staff page called notFound(): a charger, tariff or card that isn't there. */
export default function NotFound() {
  return <NotFoundState />;
}

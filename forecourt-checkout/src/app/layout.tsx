import type { ReactNode } from "react";
import { settings } from "@/lib/server/services";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Forecourt checkout",
  description:
    "Pay at the charger: card hold, live charging, idle fees and receipts.",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  const demo = settings().demo;
  return (
    <html lang="en">
      <body>
        {demo && (
          <div className="demo-banner" role="status">
            Demo mode: sample data only. No card is charged and no charger
            receives a command.
          </div>
        )}
        {children}
      </body>
    </html>
  );
}

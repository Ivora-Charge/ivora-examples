import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Installer kit",
  description: "Connect, test and hand over an OCPP charger",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

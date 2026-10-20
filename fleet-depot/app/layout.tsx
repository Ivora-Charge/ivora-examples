import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Fleet depot charging",
  description: "Ivora fleet depot template",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

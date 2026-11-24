import type { Metadata } from "next";
import { isDemo } from "@/lib/server/demo";
import { Head } from "../ui/kit";
import { Gated } from "../ui/parts";
import { ProblemAdmin } from "./problem-admin";

export const metadata: Metadata = { title: "Problems" };

export default function ProblemsPage() {
  return (
    <>
      <Head
        crumbs={["Charging"]}
        title="Problems"
        lead="What drivers report from the app at a charger: what went wrong, their words and, if they took one, a photo. Newest first."
      />
      <Gated what="see reported problems">
        <ProblemAdmin demo={isDemo()} />
      </Gated>
    </>
  );
}

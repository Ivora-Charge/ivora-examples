import { isDemo } from "@/lib/ivora";
import Wizard from "./wizard";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main>
      <h1>Installer kit</h1>
      {isDemo() && (
        <p className="demo">
          DEMO MODE: simulated charger and demo data. No real charger commands
          or payments are sent.
        </p>
      )}
      <Wizard />
    </main>
  );
}

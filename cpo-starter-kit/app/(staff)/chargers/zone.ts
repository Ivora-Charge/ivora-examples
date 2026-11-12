import { getOnboarding } from "@/lib/server/onboarding";

/** The company's time zone from Settings, or null when it is not set or does not load. */
export async function companyZone(operatorId: string): Promise<string | null> {
  try {
    return (await getOnboarding().store.load(operatorId)).timeZone;
  } catch {
    return null;
  }
}

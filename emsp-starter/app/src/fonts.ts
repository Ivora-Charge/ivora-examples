import { BricolageGrotesque_800ExtraBold } from "@expo-google-fonts/bricolage-grotesque/800ExtraBold";
import { DMMono_500Medium } from "@expo-google-fonts/dm-mono/500Medium";
import { InstrumentSans_400Regular } from "@expo-google-fonts/instrument-sans/400Regular";
import { InstrumentSans_600SemiBold } from "@expo-google-fonts/instrument-sans/600SemiBold";
import { useFonts } from "expo-font";
import { FONT } from "./theme";

/**
 * The brand fonts, bundled with the app (all SIL Open Font License 1.1): Bricolage
 * Grotesque 800 for headlines and kW figures, Instrument Sans 400 and 600 for text,
 * DM Mono 500 for EVSE IDs. To change a font, set its name in brand/tokens.json and
 * import its files here.
 */
export function useBrandFonts(): boolean {
  const [loaded, error] = useFonts({
    [FONT.heading]: BricolageGrotesque_800ExtraBold,
    [FONT.body]: InstrumentSans_400Regular,
    [FONT.bodyStrong]: InstrumentSans_600SemiBold,
    [FONT.mono]: DMMono_500Medium,
  });
  // A font that fails to load falls back to the system font rather than a blank app.
  return loaded || !!error;
}

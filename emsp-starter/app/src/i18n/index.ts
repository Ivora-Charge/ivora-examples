import { getLocales } from "expo-localization";
import { createI18n } from "./core";
import en from "./en.json";

/**
 * Languages with strings. To add one, copy `en.json` to `<language>.json`, translate
 * the values and add it here; a unit test checks it has every key.
 */
export const LANGUAGES: Record<string, Partial<Record<string, string>>> = {
  en,
};

/** The device's preferred locale, and the best language we have strings for. */
function pick(): { locale: string; messages: Partial<Record<string, string>> } {
  let locales: { languageTag: string; languageCode: string | null }[] = [];
  try {
    locales = getLocales();
  } catch {}
  const first = locales[0]?.languageTag ?? "en";
  const match = locales.find(
    (l) => l.languageCode && LANGUAGES[l.languageCode],
  );
  return {
    locale: first,
    messages: match ? LANGUAGES[match.languageCode!]! : en,
  };
}

const chosen = pick();
export const i18n = createI18n(chosen.locale, chosen.messages);
export const { t, tn } = i18n;

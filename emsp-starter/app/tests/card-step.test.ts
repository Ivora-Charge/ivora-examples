import { afterEach, describe, expect, it, vi } from "vitest";
import { cardStep } from "../src/lib/card-step";
import { config } from "../src/lib/config";

describe("what a driver's cards allow before a start", () => {
  const paying = { isDefault: true };
  const spare = { isDefault: false };

  it("starts when a card pays for charging, on every build", () => {
    for (const canAddCard of [true, false])
      expect(cardStep([spare, paying], canAddCard)).toBe("ready");
  });

  it("sends the phone apps to Wallet, which can add or choose a card", () => {
    expect(cardStep([], true)).toBe("wallet");
    expect(cardStep([spare], true)).toBe("wallet");
  });

  it("never sends a web driver without a card to Wallet: it cannot add one", () => {
    expect(cardStep([], false)).toBe("phoneApp");
  });

  it("sends a web driver to Wallet to choose among saved cards", () => {
    expect(cardStep([spare, spare], false)).toBe("wallet");
  });
});

describe("the phone app links", () => {
  afterEach(() => void vi.unstubAllEnvs());

  it("has none unless configured", () => {
    vi.stubEnv("EXPO_PUBLIC_IOS_APP_URL", "");
    vi.stubEnv("EXPO_PUBLIC_ANDROID_APP_URL", "  ");
    expect(config.iosAppUrl).toBeUndefined();
    expect(config.androidAppUrl).toBeUndefined();
  });

  it("takes each store's https address on its own", () => {
    vi.stubEnv("EXPO_PUBLIC_IOS_APP_URL", " https://apps.example/ios ");
    vi.stubEnv("EXPO_PUBLIC_ANDROID_APP_URL", "");
    expect(config.iosAppUrl).toBe("https://apps.example/ios");
    expect(config.androidAppUrl).toBeUndefined();
    vi.stubEnv("EXPO_PUBLIC_ANDROID_APP_URL", "HTTPS://apps.example/android");
    expect(config.androidAppUrl).toBe("HTTPS://apps.example/android");
  });

  it("ignores anything that is not https", () => {
    for (const url of [
      "http://apps.example/ios",
      "javascript:alert(1)",
      "apps.example/ios",
    ]) {
      vi.stubEnv("EXPO_PUBLIC_IOS_APP_URL", url);
      vi.stubEnv("EXPO_PUBLIC_ANDROID_APP_URL", url);
      expect(config.iosAppUrl).toBeUndefined();
      expect(config.androidAppUrl).toBeUndefined();
    }
  });
});

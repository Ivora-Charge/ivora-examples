import { Platform } from "react-native";
import { brand, fontFamily } from "../brand";

export { color, fontSize, fontWeight, radius, space, brand } from "../brand";

/** Font tokens resolved for the current platform. */
export const font = {
  body: fontFamily(brand.font.body, Platform.OS),
  heading: fontFamily(brand.font.heading, Platform.OS),
  mono: fontFamily(brand.font.mono, Platform.OS),
};

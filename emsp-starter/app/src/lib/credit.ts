/** A box on screen, in pixels from the top left. */
export type Box = { left: number; right: number; top: number; bottom: number };

/**
 * How to draw a map marker so that the map credit does not cover it. `0`: where the
 * map put it. A number: lifted that many pixels, to end at the credit's top edge, for
 * a marker centred above the credit's middle. `"hide"`: not drawn, for one centred
 * lower, which is mostly behind the phone's sheet below the credit.
 */
export function clearOfCredit(marker: Box, credit: Box): number | "hide" {
  const meets =
    marker.left < credit.right &&
    marker.right > credit.left &&
    marker.top < credit.bottom &&
    marker.bottom > credit.top;
  if (!meets) return 0;
  if (marker.top + marker.bottom >= credit.top + credit.bottom) return "hide";
  return Math.ceil(marker.bottom - credit.top);
}

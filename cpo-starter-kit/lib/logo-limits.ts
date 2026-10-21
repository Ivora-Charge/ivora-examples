// The logo limits Ivora's API applies, shared by the server's checks
// (lib/server/onboarding/image.ts) and the brand form's check in the browser.

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MIN_PX = 32;
export const LOGO_MAX_PX = 2048;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/**
 * Why a chosen file can't be the logo, or null. The browser checks size and type
 * before uploading, so a large file gets this message rather than the server's
 * generic body-size error; the server still checks the file's own bytes.
 */
export function logoFileProblem(file: {
  size: number;
  type: string;
}): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type))
    return "Choose a PNG, JPEG or WebP image (not SVG or other formats).";
  if (file.size > LOGO_MAX_BYTES)
    return `The logo is ${Math.ceil(file.size / 1024)} KB; the limit is ${LOGO_MAX_BYTES / 1024} KB. Export a smaller image.`;
  return null;
}

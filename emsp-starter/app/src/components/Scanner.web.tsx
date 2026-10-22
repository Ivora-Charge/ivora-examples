/**
 * The web build scans no QR codes: the driver types the charger's ID (printed beside
 * the code) instead. The phone apps scan with the camera (Scanner.tsx).
 */
export const scannerAvailable = false;

export function Scanner(_props: { onCode: (text: string) => void }) {
  return null;
}

import QRCode from "qrcode";

export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 1 });
}

export function qrPng(text: string, width = 400): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", width, margin: 1 });
}

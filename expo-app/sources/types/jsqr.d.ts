declare module 'jsqr' {
  interface QRCode {
    binaryData: number[];
    data: string;
    chunks: { type: number; text: string }[];
    version: number;
    location: {
      topRightCorner: { x: number; y: number };
      topLeftFinderPattern: { x: number; y: number };
      bottomLeftFinderPattern: { x: number; y: number };
      bottomRightCorner: { x: number; y: number };
      topRightFinderPattern: { x: number; y: number };
      bottomLeftCorner: { x: number; y: number };
      bottomRightFinderPattern: { x: number; y: number };
      topLeftCorner: { x: number; y: number };
      bottomRightCorner: { x: number; y: number };
    };
  }

  export default function jsQR(
    imageData: Uint8ClampedArray,
    width: number,
    height: number,
    inversed?: boolean,
  ): QRCode | null;
}

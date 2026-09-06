import jsQR from 'jsqr';
import { Platform } from 'react-native';

/**
 * Decode a QR code from an image file.
 *
 * - Native: delegates to `expo-camera`'s platform barcode scanner
 *   (`scanFromURLAsync`, iOS Vision / Android ML Kit).
 * - Web: decodes the picked file in the browser with jsQR (drawn onto a
 *   hidden <canvas>).
 *
 * Returns the raw QR payload, or null when no code was found / decoding
 * failed.
 */

export interface QrImageSource {
  /** file:// URI on native, blob:/data: URI on web. */
  uri: string;
  /** Raw File handle — populated by the web <input type="file"> picker. */
  file?: File | null;
}

async function decodeWithJsQr(source: QrImageSource): Promise<string | null> {
  const file = source.file;
  if (!file) return null;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null;
  }

  const canvas = document.createElement('canvas');
  let width: number;
  let height: number;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  if (bitmap) {
    width = bitmap.width;
    height = bitmap.height;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    // Fallback for browsers without createImageBitmap (older Safari).
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    }).finally(() => URL.revokeObjectURL(url));
    width = img.naturalWidth || img.width;
    height = img.naturalHeight || img.height;
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0);
  }

  if (!width || !height) return null;
  const { data } = ctx.getImageData(0, 0, width, height);
  const code = jsQR(data, width, height);
  return code ? code.data : null;
}

async function decodeWithNativeScanner(uri: string): Promise<string | null> {
  // expo-camera is a native module — import lazily so the web bundle never
  // touches it (barcode scanning from images is iOS/Android only).
  const camera = await import('expo-camera');
  const results = await camera.scanFromURLAsync(uri, ['qr']);
  if (results && results.length > 0 && results[0].data) {
    return results[0].data;
  }
  return null;
}

export async function decodeQrFromImageSource(source: QrImageSource): Promise<string | null> {
  if (!source) return null;
  if (Platform.OS === 'web') {
    // Web decoding reads from the File handle, not a uri.
    if (!source.file) return null;
    return decodeWithJsQr(source);
  }
  if (!source.uri) return null;
  return decodeWithNativeScanner(source.uri);
}

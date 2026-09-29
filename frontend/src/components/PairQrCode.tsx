/**
 * CodeConClave — PairQrCode.
 * Renders the device-pairing command as a scannable QR code (qrcode lib,
 * rendered client-side into a data URL) so users can pair devices without
 * copying the long command by hand. Falls back to the plain command text if QR
 * generation is unavailable in the current environment.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface PairQrCodeProps {
  command: string;
  alt?: string;
}

export function PairQrCode({ command, alt = 'pairing command' }: PairQrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void QRCode.toDataURL(command, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 176,
    })
      .then((url) => {
        if (mounted) setDataUrl(url);
      })
      .catch(() => {
        if (mounted) setDataUrl(null);
      });
    return () => {
      mounted = false;
    };
  }, [command]);

  if (!dataUrl) {
    return <span className="cc-hint cc-mono">{command}</span>;
  }

  return (
    <img
      src={dataUrl}
      alt={alt}
      data-testid="pair-qr"
      style={{ display: 'block', width: 176, height: 176, imageRendering: 'pixelated', background: '#fff', padding: 8, borderRadius: 8 }}
    />
  );
}
/**
 * CodeConClave — OCR Text Extraction (Tesseract.js).
 * Client-side OCR for screen captures. Runs in renderer process.
 */

export interface OCRResult {
  text: string;
  confidence: number;
  words: Array<{
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;
  lines: Array<{
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;
  language: string;
  timestamp: string;
}

export interface OCROptions {
  /** Language(s) to recognize (e.g., 'eng', 'eng+hin') */
  language?: string;
  /** Whitelist of characters to recognize */
  whitelist?: string;
  /** Blacklist of characters to ignore */
  blacklist?: string;
  /** Page segmentation mode */
  psm?: number;
  /** OCR engine mode */
  oem?: number;
  /** Logger callback */
  logger?: (info: { status: string; progress: number }) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __tesseractWorker: unknown;
}

/**
 * Browser-side OCR using Tesseract.js.
 * Loads Tesseract.js dynamically to avoid bundle bloat.
 */
export class BrowserOCR {
  private static instance: BrowserOCR | null = null;
  private worker: unknown = null;
  private loading: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): BrowserOCR {
    if (!BrowserOCR.instance) {
      BrowserOCR.instance = new BrowserOCR();
    }
    return BrowserOCR.instance;
  }

  /** Initialize Tesseract worker */
  async init(language = 'eng'): Promise<void> {
    if (this.worker) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        // Dynamically import Tesseract.js
        const { createWorker } = await import('tesseract.js');
        this.worker = await createWorker(language);
      } catch (err) {
        console.error('[OCR] Failed to initialize Tesseract:', err);
        this.worker = null;
        throw err;
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  /** Recognize text from image data */
  async recognize(
    imageData: Uint8Array | HTMLImageElement | HTMLCanvasElement | string,
    options: OCROptions = {}
  ): Promise<OCRResult> {
    await this.init(options.language ?? 'eng');

    if (!this.worker) {
      throw new Error('OCR worker not initialized');
    }

    const { language = 'eng', whitelist, blacklist, psm, oem, logger } = options;

    // Set recognition options
    if (this.worker && typeof this.worker === 'object' && 'setParameters' in this.worker) {
      const params: Record<string, string> = {};
      if (whitelist) params.tessedit_char_whitelist = whitelist;
      if (blacklist) params.tessedit_char_blacklist = blacklist;
      if (psm) params.tessedit_pageseg_mode = String(psm);
      if (oem) params.oem = String(oem);
      if (Object.keys(params).length > 0) {
        await (this.worker as { setParameters: (params: Record<string, string>) => Promise<void> }).setParameters(params);
      }
    }

    // Run recognition
    const result = await (this.worker as {
      recognize: (data: unknown) => Promise<{
        data: {
          text: string;
          confidence: number;
          words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
          lines: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
        };
      }>;
    }).recognize(imageData);

    return {
      text: result.data.text,
      confidence: result.data.confidence,
      words: result.data.words,
      lines: result.data.lines,
      language,
      timestamp: new Date().toISOString(),
    };
  }

  /** Recognize from base64 data URL */
  async recognizeDataURL(dataUrl: string, options: OCROptions = {}): Promise<OCRResult> {
    return this.recognize(dataUrl, options);
  }

  /** Recognize from image element */
  async recognizeElement(element: HTMLImageElement | HTMLCanvasElement, options: OCROptions = {}): Promise<OCRResult> {
    return this.recognize(element, options);
  }

  /** Terminate worker */
  async terminate(): Promise<void> {
    if (this.worker && typeof this.worker === 'object' && 'terminate' in this.worker) {
      await (this.worker as { terminate: () => Promise<void> }).terminate();
    }
    this.worker = null;
    BrowserOCR.instance = null;
  }

  /** Check if worker is ready */
  isReady(): boolean {
    return this.worker !== null;
  }
}

/** Quick OCR function for one-off recognition */
export async function quickOCR(
  imageData: Uint8Array | HTMLImageElement | HTMLCanvasElement | string,
  options: OCROptions = {}
): Promise<OCRResult> {
  const ocr = BrowserOCR.getInstance();
  return ocr.recognize(imageData, options);
}

/** Extract structured data from OCR result */
export function extractStructuredData(ocrResult: OCRResult): {
  emails: string[];
  urls: string[];
  phoneNumbers: string[];
  codeBlocks: string[];
  errorMessages: string[];
  keyValuePairs: Array<{ key: string; value: string }>;
} {
  const text = ocrResult.text;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  return {
    emails: [...new Set(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [])],
    urls: [...new Set(text.match(/https?:\/\/[^\s]+/g) ?? [])],
    phoneNumbers: [...new Set(text.match(/[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}/g) ?? [])],
    codeBlocks: lines.filter(l => /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*[=:(]/.test(l)),
    errorMessages: lines.filter(l => /error|exception|failed|traceback|stack trace/i.test(l)),
    keyValuePairs: lines
      .map(l => {
        const idx = l.indexOf(':');
        if (idx > 0 && idx < l.length - 1) {
          return { key: l.slice(0, idx).trim(), value: l.slice(idx + 1).trim() };
        }
        return null;
      })
      .filter((x): x is { key: string; value: string } => x !== null),
  };
}

/** Screen context summary for agent injection */
export function summarizeScreenContext(ocrResult: OCRResult): string {
  const structured = extractStructuredData(ocrResult);
  const parts: string[] = [];

  if (ocrResult.text.trim()) {
    parts.push(`Screen text (${ocrResult.confidence.toFixed(0)}% confidence):`);
    parts.push(ocrResult.text.slice(0, 2000));
  }

  if (structured.errorMessages.length > 0) {
    parts.push('\nDetected errors:');
    parts.push(structured.errorMessages.slice(0, 5).join('\n'));
  }

  if (structured.codeBlocks.length > 0) {
    parts.push('\nDetected code patterns:');
    parts.push(structured.codeBlocks.slice(0, 3).join('\n'));
  }

  if (structured.keyValuePairs.length > 0) {
    parts.push('\nKey-value pairs:');
    parts.push(structured.keyValuePairs.slice(0, 10).map(kv => `${kv.key}: ${kv.value}`).join('\n'));
  }

  return parts.join('\n');
}
/**
 * CodeConClave — Screen Context Hook.
 * Captures screen, runs OCR, injects context into chat/agents.
 */

import { useCallback, useRef, useState } from 'react';
import { BrowserOCR, summarizeScreenContext, type OCRResult, type OCROptions } from '../lib/ocr';
import { useToast } from '../components/Toast';

export interface ScreenCaptureState {
  status: 'idle' | 'capturing' | 'processing' | 'ready' | 'error';
  lastCapture?: {
    imageData: string; // base64 data URL
    ocrResult?: OCRResult;
    summary: string;
    timestamp: string;
  };
  error?: string;
}

export interface UseScreenContextOptions {
  /** Auto-capture interval (ms) - 0 for manual only */
  autoCaptureInterval?: number;
  /** OCR options */
  ocrOptions?: OCROptions;
  /** Maximum captures to keep in history */
  maxHistory?: number;
  /** Enable automatic context injection on capture */
  autoInject?: boolean;
}

export function useScreenContext(opts: UseScreenContextOptions = {}) {
  const {
    autoCaptureInterval = 0,
    ocrOptions = { language: 'eng' },
    maxHistory = 10,
    autoInject = false,
  } = opts;

  const { toast } = useToast();
  const [state, setState] = useState<ScreenCaptureState>({ status: 'idle' });
  const [history, setHistory] = useState<ScreenCaptureState['lastCapture'][]>([]);
  const intervalRef = useRef<number | null>(null);
  const ocrRef = useRef(BrowserOCR.getInstance());

  /** Capture screen using Electron's desktopCapturer (via preload) */
  const captureScreen = useCallback(async (): Promise<string | null> => {
    // Check if we're in Electron
    const isElectron = typeof window !== 'undefined' && (window as any).electronAPI?.captureScreen;

    if (!isElectron) {
      toast('Screen capture only available in desktop app', 'error');
      return null;
    }

    setState(prev => ({ ...prev, status: 'capturing' }));

    try {
      const imageData = await (window as any).electronAPI.captureScreen({
        format: 'png',
      });

      if (!imageData) {
        throw new Error('No image data returned');
      }

      // Convert to base64 data URL
      const base64 = btoa(String.fromCharCode(...new Uint8Array(imageData)));
      const dataUrl = `data:image/png;base64,${base64}`;

      setState(prev => ({ ...prev, status: 'processing' }));

      // Run OCR
      const ocrResult = await ocrRef.current.recognize(dataUrl, ocrOptions);
      const summary = summarizeScreenContext(ocrResult);

      const capture = {
        imageData: dataUrl,
        ocrResult,
        summary,
        timestamp: new Date().toISOString(),
      };

      setState(prev => ({
        ...prev,
        status: 'ready',
        lastCapture: capture,
        error: undefined,
      }));

      // Add to history
      setHistory(prev => [capture, ...prev.slice(0, maxHistory - 1)]);

      if (autoInject) {
        // Context will be available via getScreenContext()
      }

      toast('Screen captured and analyzed');
      return dataUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Capture failed';
      setState(prev => ({ ...prev, status: 'error', error: message }));
      toast(message, 'error');
      return null;
    }
  }, [ocrOptions, maxHistory, autoInject, toast]);

  /** Get current screen context for agent injection */
  const getScreenContext = useCallback((): string | null => {
    return state.lastCapture?.summary ?? null;
  }, [state.lastCapture]);

  /** Get latest OCR result */
  const getOCRResult = useCallback((): OCRResult | null => {
    return state.lastCapture?.ocrResult ?? null;
  }, [state.lastCapture]);

  /** Clear current capture */
  const clearCapture = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  /** Start auto-capture */
  const startAutoCapture = useCallback(() => {
    if (intervalRef.current) return;
    if (autoCaptureInterval <= 0) return;

    intervalRef.current = window.setInterval(() => {
      captureScreen();
    }, autoCaptureInterval);

    toast(`Auto-capture started (every ${autoCaptureInterval / 1000}s)`);
  }, [autoCaptureInterval, captureScreen, toast]);

  /** Stop auto-capture */
  const stopAutoCapture = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
      toast('Auto-capture stopped');
    }
  }, [toast]);

  /** Inject screen context into a message */
  const injectContext = useCallback((message: string): string => {
    const context = getScreenContext();
    if (!context) return message;

    return `[Screen Context]\n${context}\n\n[User Message]\n${message}`;
  }, [getScreenContext]);

  /** Get capture history */
  const getHistory = useCallback(() => history, [history]);

  // Cleanup on unmount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  return {
    state,
    captureScreen,
    getScreenContext,
    getOCRResult,
    clearCapture,
    startAutoCapture,
    stopAutoCapture,
    injectContext,
    getHistory,
    isCapturing: state.status === 'capturing' || state.status === 'processing',
  };
}
/**
 * CodeConClave — clipboard helper.
 * Prefers the async Clipboard API, falls back to a hidden textarea +
 * execCommand so copy still works in non-secure contexts and tests.
 * Returns true only when text was actually copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Split plain text into fenced code blocks + prose for rendering with copy. */
export interface ContentSegment {
  kind: 'text' | 'code';
  content: string;
}

export function splitCodeBlocks(content: string): ContentSegment[] {
  if (!/```/.test(content)) return [{ kind: 'text', content }];
  const segments: ContentSegment[] = [];
  const lines = content.split('\n');
  let i = 0;
  let textBuf: string[] = [];
  let inFence = false;
  let codeBuf: string[] = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      if (!inFence) {
        if (textBuf.length > 0) {
          segments.push({ kind: 'text', content: textBuf.join('\n') });
          textBuf = [];
        }
        inFence = true;
        codeBuf = [];
      } else {
        segments.push({ kind: 'code', content: codeBuf.join('\n') });
        codeBuf = [];
        inFence = false;
      }
    } else if (inFence) {
      codeBuf.push(line);
    } else {
      textBuf.push(line);
    }
  }
  if (textBuf.length > 0) segments.push({ kind: 'text', content: textBuf.join('\n') });
  if (codeBuf.length > 0) segments.push({ kind: 'code', content: codeBuf.join('\n') });
  return segments;
}
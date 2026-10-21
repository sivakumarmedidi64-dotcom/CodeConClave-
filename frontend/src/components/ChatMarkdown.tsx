/**
 * CodeConClave — tiny chat markdown renderer (no dependency).
 *
 * Assistant answers arrive as long plain-text walls; this renders the
 * structure authors already put in them: fenced code, headings, bold,
 * inline code, lists, quotes and links. Everything is HTML-escaped first
 * and only known-safe tags are emitted; links are http(s)-only. Anything
 * unrecognized stays readable plain text — never dropped, never executed.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { artifactStore, artifactTitle, isHtmlDocument, isPreviewable } from '../lib/artifacts';
import { ChartBlock, EmailDraftCard, FileCard, parseChart } from './RichBlocks';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(src: string): string {
  // Order: escape, then code (protects contents), links, bold, italic.
  let out = escapeHtml(src);
  const codes: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code class="cc-md-code">${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? '');
  return out;
}

interface Block {
  key: number;
  node: React.ReactNode;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const ownerId = useId();
  const autoOpened = useRef(false);
  const previewable = isPreviewable(language, code);
  const openPreview = () => artifactStore.open({ ownerId, language, code, title: artifactTitle(language, code) });

  // Live build: while this block keeps growing (streaming), push the new code
  // to the open artifact. A full HTML document opens itself once, like Claude.
  useEffect(() => {
    artifactStore.update(ownerId, code);
    if (!autoOpened.current && isHtmlDocument(code) && code.length > 120 && !artifactStore.get()) {
      autoOpened.current = true;
      openPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code stays selectable */
    }
  };
  return (
    <div className="cc-md-prewrap">
      {language && <span className="cc-md-lang">{language}</span>}
      <pre className="cc-md-pre">
        <code>{code}</code>
      </pre>
      <span className="cc-md-actions">
        {previewable && (
          <button type="button" className="cc-md-copy cc-md-preview" onClick={openPreview} aria-label="Open live preview">
            Preview
          </button>
        )}
        <button type="button" className="cc-md-copy" onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy code'}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  );
}

export function ChatMarkdown({ text }: { text: string }) {
  const blocks: Block[] = [];
  // Split fenced code first so structure inside fences is never parsed.
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  let key = 0;
  for (const part of parts) {
    if (part.startsWith('```')) {
      const inner = part.replace(/^```/, '').replace(/```$/, '');
      const nl = inner.indexOf('\n');
      const info = (nl >= 0 ? inner.slice(0, nl) : '').trim().slice(0, 100);
      const language = info.slice(0, 24);
      const code = (nl >= 0 ? inner.slice(nl + 1) : inner).replace(/\n$/, '');
      // Rich blocks (Claude-style): charts, downloadable files, email drafts.
      const lower = info.toLowerCase();
      if (lower === 'chart') {
        const spec = parseChart(code);
        blocks.push({ key: key++, node: spec ? <ChartBlock spec={spec} /> : <CodeBlock language="json" code={code} /> });
        continue;
      }
      if (lower.startsWith('file:')) {
        blocks.push({ key: key++, node: <FileCard name={info.slice(5).trim() || 'file.txt'} content={code} /> });
        continue;
      }
      if (lower === 'email') {
        blocks.push({ key: key++, node: <EmailDraftCard src={code} /> });
        continue;
      }
      blocks.push({ key: key++, node: <CodeBlock language={language} code={code} /> });
      continue;
    }
    const lines = part.split('\n');
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushList = () => {
      if (!list) return;
      const Tag = list.ordered ? 'ol' : 'ul';
      const items = list.items;
      list = null;
      blocks.push({
        key: key++,
        node: (
          <Tag className="cc-md-list">
            {items.map((li, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: renderInline(li) }} />
            ))}
          </Tag>
        ),
      });
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        flushList();
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        flushList();
        const level = h[1]!.length;
        const Tag = level === 1 ? 'h4' : level === 2 ? 'h5' : 'h6';
        blocks.push({ key: key++, node: <Tag className="cc-md-h" dangerouslySetInnerHTML={{ __html: renderInline(h[2]!) }} /> });
        continue;
      }
      if (line.startsWith('>')) {
        flushList();
        blocks.push({
          key: key++,
          node: <blockquote className="cc-md-quote" dangerouslySetInnerHTML={{ __html: renderInline(line.replace(/^>\s?/, '')) }} />,
        });
        continue;
      }
      const ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) {
        if (!list || list.ordered) {
          flushList();
          list = { ordered: false, items: [] };
        }
        list.items.push(ul[1]!);
        continue;
      }
      const ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ol) {
        if (!list || !list.ordered) {
          flushList();
          list = { ordered: true, items: [] };
        }
        list.items.push(ol[1]!);
        continue;
      }
      flushList();
      blocks.push({ key: key++, node: <p className="cc-md-p" dangerouslySetInnerHTML={{ __html: renderInline(line) }} /> });
    }
    flushList();
  }
  return (
    <>
      {blocks.map((b) => (
        <span key={b.key} className="cc-md-block">
          {b.node}
        </span>
      ))}
    </>
  );
}

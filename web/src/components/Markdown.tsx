/**
 * 极简 Markdown 渲染（无依赖）：标题、粗体、斜体、行内代码、代码块、
 * 有序/无序列表、换行、链接。流式输出时会被反复调用，实现保持线性扫描。
 */
import { Fragment, type ReactNode } from 'react';

/** 行内：`code` > **bold** > *italic* > [text](url) */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (m[4]) out.push(<em key={key}>{token.slice(1, -1)}</em>);
    else if (m[5]) {
      const label = token.slice(1, token.indexOf(']'));
      out.push(
        <a key={key} href={m[6]} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; lang: string; lines: string[] };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // 跳过收尾 fence（流未结束时可能没有）
      blocks.push({ kind: 'code', lang: fence[1] || '', lines: body });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const b = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        const n = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]);
        if (ordered ? n : b) items.push((ordered ? n : b)![1]);
        else break;
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', lines: para });
  }

  return blocks;
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = parse(text);
  return (
    <div className="md">
      {blocks.map((b, bi) => {
        const key = `b${bi}`;
        if (b.kind === 'code') {
          return (
            <pre key={key}>
              <code>{b.lines.join('\n')}</code>
            </pre>
          );
        }
        if (b.kind === 'h') {
          const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[Math.min(b.level, 4) - 1];
          return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
        }
        if (b.kind === 'list') {
          const items = b.items.map((it, ii) => <li key={ii}>{renderInline(it, `${key}-${ii}`)}</li>);
          return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
        }
        return (
          <p key={key}>
            {b.lines.map((ln, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(ln, `${key}-${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

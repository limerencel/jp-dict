/**
 * MDict 词头与记录的语义解析。
 *
 * 日语 MDict 词典普遍把词头写成 `░かな░【漢字・異体】🗏页码№序号`（明镜就是这种），
 * 需要拆出可检索的表记与读音；装饰字符与页码后缀对检索有害无益，一律清掉。
 */

/** 词头两侧的装饰方块与星标 */
const DECORATION = /[\u2591-\u2593\u2721]/gu;
/** 页码标记 🗏 / 📄 之后全是版面信息 */
const PAGE_MARKER = /[\u{1F5CF}\u{1F4C4}].*$/u;
/** 没有 🗏 时可能只剩 №序号 */
const INDEX_SUFFIX = /\u2116\s*[0-9０-９]+\s*$/u;

export interface MdictKeyParts {
  /** 主检索形：有【】时取其中第一个，否则取整个词头 */
  expression: string;
  /** 【】之前的假名部分 */
  reading: string;
  /** 【良い・善い・好い】里除第一个之外的异形 */
  altForms: string[];
}

export function cleanMdictKey(raw: string): MdictKeyParts {
  let s = raw.replace(PAGE_MARKER, '').replace(INDEX_SUFFIX, '').replace(DECORATION, '').trim();
  const empty: MdictKeyParts = { expression: '', reading: '', altForms: [] };
  if (!s) return empty;

  const bracket = /^(.*?)【(.*?)】\s*$/u.exec(s);
  if (!bracket) return { expression: s, reading: '', altForms: [] };

  const reading = bracket[1].trim();
  const forms = bracket[2]
    .split(/[・･、]/u)
    .map((f) => f.trim())
    .filter(Boolean);

  // 【】为空的词条（如 ░あ░【】）只有假名形
  if (!forms.length) return { expression: reading, reading: '', altForms: [] };
  return { expression: forms[0], reading, altForms: forms.slice(1) };
}

/** `@@@LINK=目标词头` 重定向；返回 null 表示这是一条真词条 */
export function parseAliasTarget(text: string): string | null {
  if (!text.startsWith('@@@LINK=')) return null;
  const target = text.slice(8).replace(/[\r\n\0\s]+$/u, '').trim();
  return target || null;
}

/** 记录字节是否以 @@@LINK= 开头，用来在解码整段文本前就分流 */
export function looksLikeAlias(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  // '@@@LINK='
  return (
    data[0] === 0x40 &&
    data[1] === 0x40 &&
    data[2] === 0x40 &&
    data[3] === 0x4c &&
    data[4] === 0x49 &&
    data[5] === 0x4e &&
    data[6] === 0x4b &&
    data[7] === 0x3d
  );
}

export type OrderedListStyle = 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';

export const LIST_STYLE_MARKER = 'MDWLISTSTYLE:';

function alphaValue(value: string): number | null {
  if (!/^[A-Za-z]+$/.test(value)) return null;
  let result = 0;
  for (const char of value.toLowerCase()) result = result * 26 + char.charCodeAt(0) - 96;
  return result;
}

function romanValue(value: string): number | null {
  if (!/^[ivxlcdm]+$/i.test(value)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  const lower = value.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const current = values[lower[i]];
    const next = values[lower[i + 1]] ?? 0;
    total += current < next ? -current : current;
  }
  return toRoman(total).toLowerCase() === lower ? total : null;
}

export function toAlpha(value: number, upper: boolean): string {
  if (!Number.isInteger(value) || value < 1) return String(value);
  let result = '';
  let current = value;
  while (current > 0) {
    current--;
    result = String.fromCharCode(97 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return upper ? result.toUpperCase() : result;
}

export function toRoman(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  const parts: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let current = value;
  let result = '';
  for (const [amount, token] of parts) {
    while (current >= amount) {
      result += token;
      current -= amount;
    }
  }
  return result;
}

export function orderedLabel(value: number, style: string): string {
  switch (style) {
    case 'lower-alpha': return toAlpha(value, false);
    case 'upper-alpha': return toAlpha(value, true);
    case 'lower-roman': return toRoman(value).toLowerCase();
    case 'upper-roman': return toRoman(value);
    default: return String(value);
  }
}

export function bulletMarkerAt(source: string, offset: number): '-' | '+' | '*' {
  const marker = /^\s*([-+*])/.exec(source.slice(offset))?.[1];
  return marker === '+' || marker === '*' ? marker : '-';
}

export function consumeListStyleMarker(value: string): { style: OrderedListStyle; text: string } | null {
  const match = new RegExp(`^${LIST_STYLE_MARKER}(decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)\\s+`).exec(value);
  if (!match) return null;
  return { style: match[1] as OrderedListStyle, text: value.slice(match[0].length) };
}

interface Candidate {
  line: number;
  indent: string;
  token: string;
  spacing: string;
  rest: string;
}

function candidateValue(token: string, style: OrderedListStyle): number | null {
  return style.includes('roman') ? romanValue(token) : alphaValue(token);
}

function inferStyle(group: Candidate[]): OrderedListStyle | null {
  const token0 = group[0]?.token ?? '';
  const alphaStyle: OrderedListStyle = token0 === token0.toUpperCase() ? 'upper-alpha' : 'lower-alpha';
  const romanStyle: OrderedListStyle = token0 === token0.toUpperCase() ? 'upper-roman' : 'lower-roman';
  for (const style of [romanStyle, alphaStyle]) {
    const values = group.map((item) => candidateValue(item.token, style));
    if (values.every((value) => value != null) && values.every((value, index) => index === 0 || value === values[index - 1]! + 1)) {
      // I/J and i/j are alphabetic; I/II and i/ii clearly express Roman numbering.
      if (style.includes('roman') && group.every((item) => item.token.length === 1) && group.length > 1) continue;
      return style;
    }
  }
  return null;
}

/** Convert unambiguous consecutive alphabetic/Roman markers to CommonMark decimal markers. */
export function preprocessExtendedLists(source: string): string {
  // Recover documents produced by the earlier HTML-comment marker implementation.
  source = source.replace(
    /\\?<!--MDWLISTSTYLE:(decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)-->\s*/g,
    (_match, style: OrderedListStyle) => `${LIST_STYLE_MARKER}${style} `
  );
  const lines = source.split(/\r?\n/);
  const candidates: Candidate[] = [];
  let fence: { char: string; size: number } | null = null;

  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})/.exec(raw);
    if (fenceMatch) {
      const chars = fenceMatch[2];
      if (!fence) fence = { char: chars[0], size: chars.length };
      else if (chars[0] === fence.char && chars.length >= fence.size) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^(\s*)([A-Za-z]+)\.([ \t]+)(.*)$/.exec(raw);
    if (match) candidates.push({ line, indent: match[1], token: match[2], spacing: match[3], rest: match[4] });
  }

  for (let i = 0; i < candidates.length;) {
    let regionEnd = i + 1;
    while (regionEnd < candidates.length) {
      const previous = candidates[regionEnd - 1];
      const next = candidates[regionEnd];
      if (next.indent !== previous.indent) break;
      if (lines.slice(previous.line + 1, next.line).some((line) => line.trim() !== '')) break;
      regionEnd++;
    }

    let matchedEnd = -1;
    let matchedStyle: OrderedListStyle | null = null;
    for (let end = i + 2; end <= regionEnd; end++) {
      const style = inferStyle(candidates.slice(i, end));
      if (!style) break;
      matchedEnd = end;
      matchedStyle = style;
    }
    if (matchedStyle && matchedEnd > i) {
      const group = candidates.slice(i, matchedEnd);
      const metadata = `${LIST_STYLE_MARKER}${matchedStyle} `;
      const delimiter = matchedStyle.includes('roman') ? ')' : '.';
      group.forEach((item, index) => {
        const value = candidateValue(item.token, matchedStyle)!;
        lines[item.line] = `${item.indent}${value}${delimiter}${item.spacing}${index === 0 ? metadata : ''}${item.rest}`;
      });
      i = matchedEnd;
    } else {
      i++;
    }
  }
  return lines.join('\n');
}

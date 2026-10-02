import { SaxesParser } from 'saxes';

const SVG = 'http://www.w3.org/2000/svg';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XLINK = 'http://www.w3.org/1999/xlink';
const elements = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'use',
  'symbol',
  'switch',
  'clippath',
  'mask',
  'pattern',
  'lineargradient',
  'radialgradient',
  'stop',
  'marker',
  'image',
  'filter',
  'feblend',
  'fecolormatrix',
  'fecomponenttransfer',
  'fecomposite',
  'feconvolvematrix',
  'fediffuselighting',
  'fedisplacementmap',
  'fedistantlight',
  'fedropshadow',
  'feflood',
  'fefunca',
  'fefuncb',
  'fefuncg',
  'fefuncr',
  'fegaussianblur',
  'feimage',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fepointlight',
  'fespecularlighting',
  'fespotlight',
  'fetile',
  'feturbulence',
  'style',
  'a',
]);
const cssAttributes = new Set([
  'style',
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'cursor',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'font',
  'font-family',
  'color',
  'background',
  'background-image',
]);
const functions = new Set([
  'url',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'calc',
  'min',
  'max',
  'clamp',
  'var',
  'translate',
  'translatex',
  'translatey',
  'scale',
  'scalex',
  'scaley',
  'rotate',
  'matrix',
  'skewx',
  'skewy',
]);
const fragment = (value: string) => /^#[\p{L}\p{N}_.:-]+$/u.test(value);
const fail = (): never => {
  throw new Error(
    '실행 코드·외부 참조·동적 요소가 없는 정적 SVG만 사용할 수 있습니다. PNG로 변환하거나 외부 참조를 제거하세요.',
  );
};
function staticCss(value: string) {
  // Deliberately reject CSS escapes/comments: they can conceal resource functions and at-rules.
  if (
    /[\\@]|\/\*|\*\/|expression\s*\(|(?:javascript|file|data|https?)\s*:|(?:behavior|-moz-binding)\s*:/i.test(
      value,
    )
  )
    fail();
  for (const match of value.matchAll(/([-\w]+)\s*\(/g))
    if (!functions.has(match[1].toLowerCase())) fail();
  for (const match of value.matchAll(/url\s*\(\s*([^)]*)\)/gi)) {
    let target = match[1].trim();
    if (
      (target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'"))
    )
      target = target.slice(1, -1);
    if (!fragment(target)) fail();
  }
  // A malformed unmatched url function must not be left to another renderer's error recovery.
  if ((value.match(/url\s*\(/gi) ?? []).length !== [...value.matchAll(/url\s*\([^)]*\)/gi)].length)
    fail();
}

/** Validates XML structure and a conservative, static SVG subset; does not rewrite the file. */
export function assertSafeSvg(svg: string): void {
  if (!svg || svg.length > 10 * 1024 * 1024 || svg.includes('\u0000')) fail();
  const parser = new SaxesParser({ xmlns: true });
  let nodes = 0;
  const stack: string[] = [];
  let style = '';
  let rootSeen = false;
  parser.on('error', () => fail());
  parser.on('doctype', () => fail());
  parser.on('processinginstruction', () => fail());
  parser.on('xmldecl', (decl) => {
    if (decl.encoding && !/^utf-8$/i.test(decl.encoding)) fail();
  });
  parser.on('opentag', (tag) => {
    const local = tag.local.toLowerCase();
    if (++nodes > 100000 || stack.length > 128 || stack[stack.length - 1] === 'style') fail();
    if ((tag.uri && tag.uri !== SVG) || !elements.has(local)) fail();
    if (!rootSeen) {
      if (local !== 'svg') fail();
      rootSeen = true;
    }
    for (const attribute of Object.values(tag.attributes)) {
      const key = attribute.local.toLowerCase(),
        value = attribute.value;
      if (attribute.uri === XMLNS) continue;
      if (attribute.uri && ![SVG, XML, XLINK].includes(attribute.uri)) fail();
      if (key.startsWith('on') || key === 'base' || key === 'srcset') fail();
      if (key === 'href' || key === 'src') {
        if (!fragment(value)) fail();
      }
      if (cssAttributes.has(key)) staticCss(value);
    }
    stack.push(local);
    if (local === 'style') style = '';
  });
  const text = (value: string) => {
    if (stack[stack.length - 1] === 'style') style += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    if (stack.pop() === 'style') staticCss(style);
  });
  try {
    parser.write(svg).close();
  } catch {
    fail();
  }
  if (!rootSeen || stack.length) fail();
}

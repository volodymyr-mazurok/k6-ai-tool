// Traceability of the report's numbers (design P9). Every number on the page is an element
//
//   <span class="num" data-src="summary.json#metrics[&quot;http_req_duration{name:a.b}&quot;].values[&quot;p(95)&quot;]" data-fmt="int">812</span>
//
// whose text is `format(data-fmt, evaluate(data-src))` (formats.ts). The page builder gets its numbers the same way (it
// evaluates the expression it writes into data-src), and `perf report --verify-sources` (verify.ts) evaluates each
// expression again against the files on disk and compares the text. A number a reader cannot trace to a file does not appear.
//
// A source expression is arithmetic over references:
//
//   ref   := <file>#<path>         file: summary.json, timeseries.json, db.json or meta.json of the run folder. Nothing outside
//                                  it is a source: the baseline slot and the limits the run applied are copied into meta.json
//                                  (meta.json#baseline.steps["…"].p95, meta.json#rules.flags.errorRate)
//   path  := key | .key | ["any key"] | [3] | [*] | [t>=120&t<720]
//                                  [*] takes every element of an array; [t>=A&t<B] the elements whose number `t` is in range
//                                  (<, <=, >, >=, joined by &); both make the reference an array of numbers (null kept)
//   expr  := numbers, refs, + - * /, ( ), and sum / avg / min / max / count / wavg over arrays
//           (wavg(values, weights) skips pairs whose value is null or weight is 0)
//
// A reference to an array must be reduced by a function; null elements (a bucket with no p95) are skipped by them.

export type SourceFile = 'summary.json' | 'timeseries.json' | 'db.json' | 'meta.json';
/** The parsed content of each file the report can cite; a file the run does not have is absent. */
export type Sources = Partial<Record<SourceFile, unknown>>;

export const SOURCE_FILES: readonly SourceFile[] = ['summary.json', 'timeseries.json', 'db.json', 'meta.json'];

/** `empty`: the expression is well formed but has nothing to compute (0 / 0, the average of no samples). `invalid`: it cannot be evaluated. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly kind: 'empty' | 'invalid',
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

const invalid = (message: string): SourceError => new SourceError(message, 'invalid');
const empty = (message: string): SourceError => new SourceError(message, 'empty');

// ---------------------------------------------------------------------------------------------------------------
// writing paths
// ---------------------------------------------------------------------------------------------------------------

/** A bracket that is not a plain key or index: `[*]` or a window. */
export interface Bracket {
  bracket: string;
}
export type PathPart = string | number | Bracket;

/** `[*]`: every element. */
export const ALL: Bracket = { bracket: '*' };

/**
 * `[key>=from&key<to]`: the elements whose number `key` is in range (`to` included with `inclusiveEnd`). Either bound may
 * be null (open). Elements without a number there (a database sample whose time is unknown) never pass.
 */
export function window(key: string, from: number | null, to: number | null, inclusiveEnd = false): Bracket {
  const clauses = [from === null ? null : `${key}>=${from}`, to === null ? null : `${key}${inclusiveEnd ? '<=' : '<'}${to}`].filter(
    (clause): clause is string => clause !== null,
  );
  if (clauses.length === 0) throw new RangeError('window needs at least one bound');
  return { bracket: clauses.join('&') };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A path in the notation above. Identifiers are written with dots, any other key in `["…"]`. */
export function jsonPath(parts: PathPart[]): string {
  return parts
    .map((part, i) => {
      if (typeof part === 'number') return `[${part}]`;
      if (typeof part !== 'string') return `[${part.bracket}]`;
      if (IDENT.test(part)) return i === 0 ? part : `.${part}`;
      return `[${JSON.stringify(part)}]`;
    })
    .join('');
}

/** `<file>#<path>`. */
export function source(file: SourceFile, ...parts: PathPart[]): string {
  return `${file}#${jsonPath(parts)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// reading paths
// ---------------------------------------------------------------------------------------------------------------

interface Clause {
  key: string;
  op: '>=' | '<=' | '>' | '<';
  n: number;
}
type Seg = { k: 'key'; key: string } | { k: 'index'; i: number } | { k: 'all' } | { k: 'window'; clauses: Clause[] };

const NUMBER = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i;
const CLAUSE = /^([A-Za-z_]\w*)(>=|<=|>|<)(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i;
const IDENT_AT = /^[A-Za-z_][A-Za-z0-9_]*/;

function parseBracket(inner: string, at: string): Seg {
  if (inner === '*') return { k: 'all' };
  if (/^\d+$/.test(inner)) return { k: 'index', i: Number(inner) };
  const clauses = inner.split('&').map((text): Clause => {
    const m = CLAUSE.exec(text);
    if (!m) throw invalid(`${at}: "[${inner}]" is not an index, [*] or a window like [t>=0&t<60]`);
    return { key: m[1]!, op: m[2] as Clause['op'], n: Number(m[3]) };
  });
  return { k: 'window', clauses };
}

/** Read a path starting at `start`; returns its segments and where it ended. */
function scanPath(text: string, start: number): { segs: Seg[]; end: number } {
  const segs: Seg[] = [];
  let i = start;
  const first = IDENT_AT.exec(text.slice(i));
  if (first) {
    segs.push({ k: 'key', key: first[0] });
    i += first[0].length;
  }
  for (;;) {
    if (text[i] === '.') {
      const m = IDENT_AT.exec(text.slice(i + 1));
      if (!m) break;
      segs.push({ k: 'key', key: m[0] });
      i += 1 + m[0].length;
    } else if (text[i] === '[') {
      if (text[i + 1] === '"') {
        let j = i + 2;
        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        if (j >= text.length || text[j + 1] !== ']') throw invalid(`unterminated ["…"] in "${text.slice(start)}"`);
        let key: unknown;
        try {
          key = JSON.parse(text.slice(i + 1, j + 1));
        } catch {
          throw invalid(`bad key ${text.slice(i + 1, j + 1)} in "${text.slice(start)}"`);
        }
        segs.push({ k: 'key', key: String(key) });
        i = j + 2;
      } else {
        const close = text.indexOf(']', i);
        if (close < 0) throw invalid(`missing ] in "${text.slice(start)}"`);
        segs.push(parseBracket(text.slice(i + 1, close), text.slice(start)));
        i = close + 1;
      }
    } else {
      break;
    }
  }
  return { segs, end: i };
}

type Value = number | (number | null)[];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function inWindow(element: unknown, clauses: Clause[]): boolean {
  if (!isRecord(element)) return false;
  return clauses.every(({ key, op, n }) => {
    const v = element[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    return op === '>=' ? v >= n : op === '<=' ? v <= n : op === '>' ? v > n : v < n;
  });
}

function resolveRef(file: string, segs: Seg[], sources: Sources, label: string): Value {
  const root = (sources as Record<string, unknown>)[file];
  if (root === undefined) throw invalid(`${label}: ${file} is not available for this run`);
  let nodes: unknown[] = [root];
  let many = false;
  const asArray = (node: unknown, what: string): unknown[] => {
    if (!Array.isArray(node)) throw invalid(`${label}: ${what} is not an array`);
    return node;
  };
  for (const seg of segs) {
    switch (seg.k) {
      case 'key':
        nodes = nodes.map((node) => {
          if (!isRecord(node) || !Object.hasOwn(node, seg.key)) throw invalid(`${label}: no "${seg.key}"`);
          return node[seg.key];
        });
        break;
      case 'index':
        nodes = nodes.map((node) => {
          const list = asArray(node, `the value before [${seg.i}]`);
          if (seg.i >= list.length) throw invalid(`${label}: index ${seg.i} is past the end of the array`);
          return list[seg.i];
        });
        break;
      case 'all':
        nodes = nodes.flatMap((node) => asArray(node, 'the value before [*]'));
        many = true;
        break;
      case 'window':
        nodes = nodes.flatMap((node) => asArray(node, 'the value before the window').filter((e) => inWindow(e, seg.clauses)));
        many = true;
        break;
    }
  }
  const numbers = nodes.map((node): number | null => {
    if (node === null && many) return null;
    if (typeof node !== 'number' || !Number.isFinite(node)) throw invalid(`${label}: ${node === null ? 'is null' : 'is not a number'}`);
    return node;
  });
  return many ? numbers : numbers[0]!;
}

// ---------------------------------------------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------------------------------------------

type Token =
  | { t: 'num'; n: number }
  | { t: 'ref'; file: string; segs: Seg[]; label: string }
  | { t: 'name'; name: string }
  | { t: 'op'; op: '+' | '-' | '*' | '/' | '(' | ')' | ',' };

const REF_START = /^(?:summary|timeseries|db|meta)\.json#/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = text.slice(i);
    const num = NUMBER.exec(rest);
    if (num) {
      tokens.push({ t: 'num', n: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ref = REF_START.exec(rest);
    if (ref) {
      const file = ref[0].slice(0, -1);
      const { segs, end } = scanPath(text, i + ref[0].length);
      tokens.push({ t: 'ref', file, segs, label: text.slice(i, end) });
      i = end;
      continue;
    }
    const name = /^[a-z]+(?=\s*\()/.exec(rest);
    if (name) {
      tokens.push({ t: 'name', name: name[0] });
      i += name[0].length;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      tokens.push({ t: 'op', op: c as '+' });
      i++;
      continue;
    }
    throw invalid(`cannot read "${rest.slice(0, 30)}" in "${text}"`);
  }
  return tokens;
}

const FUNCTIONS = ['sum', 'avg', 'min', 'max', 'count', 'wavg'] as const;
type FunctionName = (typeof FUNCTIONS)[number];

const present = (values: (number | null)[]): number[] => values.filter((v): v is number => v !== null);
const asList = (value: Value): (number | null)[] => (Array.isArray(value) ? value : [value]);

function callFunction(name: FunctionName, args: Value[]): number {
  if (name === 'wavg') {
    if (args.length !== 2) throw invalid('wavg takes (values, weights)');
    const values = asList(args[0]!);
    const weights = asList(args[1]!);
    if (values.length !== weights.length) throw invalid('wavg: values and weights differ in length');
    let total = 0;
    let weight = 0;
    values.forEach((v, i) => {
      const w = weights[i]!;
      if (v === null || w === null || !(w > 0)) return;
      total += v * w;
      weight += w;
    });
    if (weight === 0) throw empty('wavg: no value with a weight');
    return total / weight;
  }
  const numbers = present(args.flatMap(asList));
  switch (name) {
    case 'sum':
      return numbers.reduce((total, n) => total + n, 0);
    case 'count':
      return numbers.length;
    case 'avg':
      if (numbers.length === 0) throw empty('avg of no values');
      return numbers.reduce((total, n) => total + n, 0) / numbers.length;
    case 'min':
      if (numbers.length === 0) throw empty('min of no values');
      return Math.min(...numbers);
    case 'max':
      if (numbers.length === 0) throw empty('max of no values');
      return Math.max(...numbers);
  }
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly sources: Sources,
    private readonly text: string,
  ) {}

  run(): number {
    const value = this.expression();
    if (this.pos < this.tokens.length) throw invalid(`unexpected input in "${this.text}"`);
    if (Array.isArray(value)) throw invalid(`"${this.text}" is an array: reduce it with sum, avg, min, max, count or wavg`);
    if (!Number.isFinite(value)) throw invalid(`"${this.text}" is not a finite number`);
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(op: string): boolean {
    const token = this.peek();
    return token?.t === 'op' && token.op === op;
  }

  private scalar(value: Value, op: string): number {
    if (Array.isArray(value)) throw invalid(`an array cannot be used with "${op}" in "${this.text}": reduce it first`);
    return value;
  }

  private expression(): Value {
    let left = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.pos++] as { op: '+' | '-' }).op;
      const right = this.scalar(this.term(), op);
      left = op === '+' ? this.scalar(left, op) + right : this.scalar(left, op) - right;
    }
    return left;
  }

  private term(): Value {
    let left = this.factor();
    while (this.isOp('*') || this.isOp('/')) {
      const op = (this.tokens[this.pos++] as { op: '*' | '/' }).op;
      const right = this.scalar(this.factor(), op);
      if (op === '/' && right === 0) throw empty(`division by zero in "${this.text}"`);
      left = op === '*' ? this.scalar(left, op) * right : this.scalar(left, op) / right;
    }
    return left;
  }

  private factor(): Value {
    const token = this.tokens[this.pos++];
    if (!token) throw invalid(`"${this.text}" ends where a value was expected`);
    if (token.t === 'num') return token.n;
    if (token.t === 'ref') return resolveRef(token.file, token.segs, this.sources, token.label);
    if (token.t === 'op' && token.op === '-') return -this.scalar(this.factor(), '-');
    if (token.t === 'op' && token.op === '(') {
      const inner = this.expression();
      this.close();
      return inner;
    }
    if (token.t === 'name') {
      if (!(FUNCTIONS as readonly string[]).includes(token.name)) throw invalid(`unknown function ${token.name} in "${this.text}"`);
      this.pos++; // the "(" the tokenizer checked for
      const args: Value[] = [];
      if (!this.isOp(')')) {
        do {
          args.push(this.expression());
        } while (this.isOp(',') && ++this.pos);
      }
      this.close();
      return callFunction(token.name as FunctionName, args);
    }
    throw invalid(`unexpected input in "${this.text}"`);
  }

  private close(): void {
    if (!this.isOp(')')) throw invalid(`missing ) in "${this.text}"`);
    this.pos++;
  }
}

/**
 * The value of a source expression against the parsed files.
 * @throws {SourceError} `invalid` for a path or expression that cannot be read, `empty` when there is nothing to compute
 */
export function evaluate(expression: string, sources: Sources): number {
  return new Parser(tokenize(expression), sources, expression).run();
}

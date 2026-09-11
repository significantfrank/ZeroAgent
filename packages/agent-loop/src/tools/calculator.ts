/**
 * A tiny arithmetic expression evaluator.
 *
 * It exists so the bundled `calculator` tool can do real work without pulling in
 * a dependency **and** without ever calling `eval`, which would turn a
 * model-authored string into arbitrary code execution.
 *
 * Grammar (lowest to highest precedence):
 *
 * ```text
 * expression := term (('+' | '-') term)*
 * term       := unary (('*' | '/' | '%') unary)*
 * unary      := ('-' | '+') unary | power
 * power      := primary ('^' unary)?          // right associative
 * primary    := number | constant | name '(' args ')' | '(' expression ')'
 * ```
 */

export class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorError';
  }
}

interface NumberToken {
  kind: 'number';
  value: number;
  pos: number;
}
interface NameToken {
  kind: 'name';
  value: string;
  pos: number;
}
interface PunctToken {
  kind: 'punct';
  value: string;
  pos: number;
}
type Token = NumberToken | NameToken | PunctToken;

const NUMBER_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const PUNCTUATION = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',']);
/** Rejected outright: these must never be combinable into code. */
const FORBIDDEN = /[;'"`\\[\]{}<>=!&|?:@#$~]/;

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

interface FunctionSpec {
  minArgs: number;
  /** `Infinity` for variadic functions. */
  maxArgs: number;
  apply: (args: number[]) => number;
}

const FUNCTIONS: Record<string, FunctionSpec> = {
  abs: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.abs(x as number) },
  sqrt: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.sqrt(x as number) },
  cbrt: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.cbrt(x as number) },
  exp: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.exp(x as number) },
  log: { minArgs: 1, maxArgs: 2, apply: (args) => (args.length === 1 ? Math.log(args[0] as number) : Math.log(args[0] as number) / Math.log(args[1] as number)) },
  ln: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.log(x as number) },
  log2: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.log2(x as number) },
  log10: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.log10(x as number) },
  round: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.round(x as number) },
  floor: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.floor(x as number) },
  ceil: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.ceil(x as number) },
  trunc: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.trunc(x as number) },
  sign: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.sign(x as number) },
  sin: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.sin(x as number) },
  cos: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.cos(x as number) },
  tan: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.tan(x as number) },
  asin: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.asin(x as number) },
  acos: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.acos(x as number) },
  atan: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.atan(x as number) },
  sinh: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.sinh(x as number) },
  cosh: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.cosh(x as number) },
  tanh: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.tanh(x as number) },
  pow: { minArgs: 2, maxArgs: 2, apply: ([a, b]) => (a as number) ** (b as number) },
  hypot: { minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, apply: (args) => Math.hypot(...args) },
  min: { minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, apply: (args) => Math.min(...args) },
  max: { minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, apply: (args) => Math.max(...args) },
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (FORBIDDEN.test(char)) {
      throw new CalculatorError(`Illegal character "${char}" at position ${index}`);
    }

    if (/[0-9.]/.test(char)) {
      const match = NUMBER_PATTERN.exec(input.slice(index));
      if (match === null) throw new CalculatorError(`Malformed number at position ${index}`);
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new CalculatorError(`Number out of range at position ${index}`);
      tokens.push({ kind: 'number', value, pos: index });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = NAME_PATTERN.exec(input.slice(index));
      if (match === null) throw new CalculatorError(`Malformed identifier at position ${index}`);
      tokens.push({ kind: 'name', value: match[0], pos: index });
      index += match[0].length;
      continue;
    }

    if (char === '*' && input[index + 1] === '*') {
      tokens.push({ kind: 'punct', value: '^', pos: index });
      index += 2;
      continue;
    }

    if (PUNCTUATION.has(char)) {
      tokens.push({ kind: 'punct', value: char, pos: index });
      index += 1;
      continue;
    }

    throw new CalculatorError(`Unexpected character "${char}" at position ${index}`);
  }

  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    if (this.tokens.length === 0) throw new CalculatorError('Empty expression');
    const value = this.parseExpression();
    const trailing = this.peek();
    if (trailing !== undefined) {
      throw new CalculatorError(`Unexpected "${tokenText(trailing)}" at position ${trailing.pos}`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index];
    if (token !== undefined) this.index += 1;
    return token;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expect(value: string): void {
    if (!this.matchPunct(value)) {
      const token = this.peek();
      const found = token === undefined ? 'end of expression' : `"${tokenText(token)}"`;
      throw new CalculatorError(`Expected "${value}" but found ${found}`);
    }
  }

  private parseExpression(): number {
    let left = this.parseTerm();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'punct' || (token.value !== '+' && token.value !== '-')) break;
      this.index += 1;
      const right = this.parseTerm();
      left = token.value === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'punct') break;
      if (token.value !== '*' && token.value !== '/' && token.value !== '%') break;
      this.index += 1;
      const right = this.parseUnary();
      if (token.value === '*') {
        left *= right;
      } else if (token.value === '/') {
        if (right === 0) throw new CalculatorError('Division by zero');
        left /= right;
      } else {
        if (right === 0) throw new CalculatorError('Modulo by zero');
        left %= right;
      }
    }
    return left;
  }

  private parseUnary(): number {
    const token = this.peek();
    if (token?.kind === 'punct' && (token.value === '-' || token.value === '+')) {
      this.index += 1;
      const value = this.parseUnary();
      return token.value === '-' ? -value : value;
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    if (this.matchPunct('^')) {
      // Right associative, and the exponent may itself be signed: 2^-1.
      const exponent = this.parseUnary();
      return base ** exponent;
    }
    return base;
  }

  private parsePrimary(): number {
    const token = this.next();
    if (token === undefined) throw new CalculatorError('Unexpected end of expression');

    if (token.kind === 'number') return token.value;

    if (token.kind === 'name') {
      const name = token.value.toLowerCase();

      if (this.peek()?.kind === 'punct' && (this.peek() as PunctToken).value === '(') {
        this.index += 1;
        const args: number[] = [];
        if (!this.matchPunct(')')) {
          for (;;) {
            args.push(this.parseExpression());
            if (this.matchPunct(',')) continue;
            this.expect(')');
            break;
          }
        }
        return applyFunction(name, args);
      }

      const constant = CONSTANTS[name];
      if (constant === undefined) {
        const known = [...Object.keys(CONSTANTS), ...Object.keys(FUNCTIONS)].sort().join(', ');
        throw new CalculatorError(`Unknown identifier "${token.value}". Known names: ${known}`);
      }
      return constant;
    }

    if (token.value === '(') {
      const value = this.parseExpression();
      this.expect(')');
      return value;
    }

    throw new CalculatorError(`Unexpected "${token.value}" at position ${token.pos}`);
  }
}

function tokenText(token: Token): string {
  return token.kind === 'number' ? String(token.value) : token.value;
}

function applyFunction(name: string, args: number[]): number {
  const spec = FUNCTIONS[name];
  if (spec === undefined) {
    throw new CalculatorError(`Unknown function "${name}"`);
  }
  if (args.length < spec.minArgs || args.length > spec.maxArgs) {
    const expected =
      spec.maxArgs === Number.POSITIVE_INFINITY
        ? `at least ${spec.minArgs}`
        : spec.minArgs === spec.maxArgs
          ? String(spec.minArgs)
          : `${spec.minArgs}-${spec.maxArgs}`;
    throw new CalculatorError(`"${name}" expects ${expected} argument(s), received ${args.length}`);
  }
  return spec.apply(args);
}

/** Longest expression accepted, as a cheap guard against pathological input. */
const MAX_EXPRESSION_LENGTH = 10_000;

/**
 * Evaluate an arithmetic expression.
 *
 * @throws {CalculatorError} on syntax errors, unknown names, division by zero,
 * or a non-finite result.
 */
export function evaluateExpression(expression: string): number {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new CalculatorError(`Expression too long (max ${MAX_EXPRESSION_LENGTH} characters)`);
  }
  const result = new Parser(tokenize(expression)).parse();
  if (!Number.isFinite(result)) {
    throw new CalculatorError('Result is not a finite number');
  }
  return result;
}

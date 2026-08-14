/**
 * Expressions over named parameters.
 *
 * This is what turns a generated model from a *result* into a *design*. Today the assistant
 * emits thirty components at literal coordinates: change the wheelbase and nothing follows,
 * because nothing in the model knows the wheelbase existed. Re-prompting does not edit that
 * model, it replaces it with a different one.
 *
 * With expressions, a plan can say `wheelbase = 2335` once and place the rear axle at
 * `wheelbase / 2`. Editing the parameter moves every part derived from it, which is what
 * "parametric" means outside this app and what design intent surviving actually looks like.
 *
 * Evaluated by a hand-written parser rather than by `Function` or `eval`. An expression here
 * arrives from a language model over the network, and handing that to a JavaScript evaluator
 * would be a remote code execution hole wearing a CAD hat. Nothing in this grammar can reach
 * anything outside the numbers it is given.
 */

/**
 * Functions an expression may call. Degrees, because drawings are in degrees.
 *
 * Every lookup into this table and into `CONSTANTS` goes through `Object.hasOwn`. A plain
 * object literal inherits Object.prototype, so a bare `FUNCTIONS[name]` treats `constructor`,
 * `toString` and `valueOf` as callable — and these names come straight from a language model.
 */
const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  abs: Math.abs,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sqrt: Math.sqrt,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
  hypot: (...a) => Math.hypot(...a),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export interface ExprResult {
  value: number;
  /** Why the expression could not be evaluated. */
  error?: string;
  /** Parameter names the expression read, for dependency ordering. */
  uses: string[];
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string };

function tokenise(src: string): Token[] | string {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      // Exponent form, so a plan can write 1.5e3 without it parsing as `1.5 * e * 3`.
      if (src[j] === 'e' || src[j] === 'E') {
        const k = src[j + 1] === '+' || src[j + 1] === '-' ? j + 2 : j + 1;
        if (k < src.length && /[0-9]/.test(src[k])) {
          j = k;
          while (j < src.length && /[0-9]/.test(src[j])) j++;
        }
      }
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) return `"${src.slice(i, j)}" is not a number.`;
      out.push({ t: 'num', v });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }

    if ('+-*/%^(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }

    return `"${c}" is not something an expression can contain.`;
  }

  return out;
}

/**
 * Evaluates an expression against a set of named values.
 *
 * Recursive descent over the usual precedence: `+ -` below `* / %` below `^`, with unary minus
 * and parentheses. Errors are messages a user can act on rather than parser jargon.
 */
export function evaluateExpr(src: string, values: Record<string, number>): ExprResult {
  const uses: string[] = [];
  const tokens = tokenise(src);
  if (typeof tokens === 'string') return { value: 0, error: tokens, uses };
  if (tokens.length === 0) return { value: 0, error: 'The expression is empty.', uses };

  let at = 0;
  let failure: string | null = null;

  const peek = (): Token | undefined => tokens[at];
  const eat = (v: string): boolean => {
    const t = peek();
    if (t && t.t === 'op' && t.v === v) { at++; return true; }
    return false;
  };

  const primary = (): number => {
    const t = peek();
    if (!t) { failure ??= 'The expression ends too early.'; return 0; }

    if (t.t === 'num') { at++; return t.v; }

    if (t.t === 'op' && t.v === '(') {
      at++;
      const v = sum();
      if (!eat(')')) failure ??= 'A bracket was opened and never closed.';
      return v;
    }

    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      at++;
      const v = primary();
      return t.v === '-' ? -v : v;
    }

    if (t.t === 'name') {
      at++;
      const name = t.v;

      // A function call, if a bracket follows.
      if (peek()?.t === 'op' && (peek() as { v: string }).v === '(') {
        at++;
        const args: number[] = [];
        if (!eat(')')) {
          for (;;) {
            args.push(sum());
            if (eat(')')) break;
            if (!eat(',')) { failure ??= `The call to ${name}() is missing a bracket.`; break; }
          }
        }
        const key = name.toLowerCase();
        if (!Object.hasOwn(FUNCTIONS, key)) {
          failure ??= `There is no function called ${name}.`;
          return 0;
        }
        return FUNCTIONS[key](...args);
      }

      const key = name.toLowerCase();
      if (Object.hasOwn(CONSTANTS, key)) return CONSTANTS[key];

      // `hasOwn`, never `in`. A plain object inherits `constructor`, `toString` and the rest
      // of Object.prototype, so `in` reports them as parameters and hands back a *function*
      // where a number belongs. The expression arrives from a language model over the
      // network, and letting it reach anything on the prototype chain is not a class of
      // problem worth having.
      if (Object.hasOwn(values, name)) {
        uses.push(name);
        return values[name];
      }

      uses.push(name);
      failure ??= `There is no parameter called ${name}.`;
      return 0;
    }

    failure ??= `"${t.v}" cannot start a value.`;
    at++;
    return 0;
  };

  // Right-associative, so 2^3^2 is 2^9 as in every other engineering tool.
  const power = (): number => {
    const base = primary();
    if (eat('^')) return Math.pow(base, power());
    return base;
  };

  const product = (): number => {
    let v = power();
    for (;;) {
      if (eat('*')) v *= power();
      else if (eat('/')) {
        const d = power();
        if (d === 0) { failure ??= 'The expression divides by zero.'; return 0; }
        v /= d;
      } else if (eat('%')) {
        const d = power();
        if (d === 0) { failure ??= 'The expression takes a remainder by zero.'; return 0; }
        v %= d;
      } else break;
    }
    return v;
  };

  function sum(): number {
    let v = product();
    for (;;) {
      if (eat('+')) v += product();
      else if (eat('-')) v -= product();
      else break;
    }
    return v;
  }

  const value = sum();
  if (failure) return { value: 0, error: failure, uses };
  if (at < tokens.length) {
    const t = tokens[at];
    return { value: 0, error: `Unexpected "${t.v}" after the expression.`, uses };
  }
  if (!Number.isFinite(value)) {
    return { value: 0, error: 'The expression does not produce a finite number.', uses };
  }

  return { value, uses };
}

export interface Parameter {
  name: string;
  /** A literal, or an expression over the other parameters. */
  value: number | string;
  units: string;
  /** Why this value — shown in the editor, so a figure can be checked. */
  note?: string;
}

export interface ResolvedParameters {
  values: Record<string, number>;
  errors: Map<string, string>;
}

/**
 * Resolves a parameter table, allowing parameters to be defined in terms of each other.
 *
 * Iterative rather than topological, because a plan is written by a language model and will
 * not arrive in dependency order. Each pass evaluates whatever is now resolvable; when a pass
 * resolves nothing, whatever is left is either circular or refers to something that does not
 * exist, and both are reported by name rather than left as a silent zero.
 */
export function resolveParameters(params: Parameter[]): ResolvedParameters {
  const values: Record<string, number> = {};
  const errors = new Map<string, string>();

  const pending = new Map<string, Parameter>();
  for (const p of params) {
    if (!p.name) continue;
    if (typeof p.value === 'number') {
      if (Number.isFinite(p.value)) values[p.name] = p.value;
      else errors.set(p.name, 'The value is not a number.');
      continue;
    }
    pending.set(p.name, p);
  }

  while (pending.size > 0) {
    let progressed = false;

    for (const [name, p] of [...pending]) {
      const r = evaluateExpr(String(p.value), values);
      if (r.error) continue;                 // may resolve once something else does

      values[name] = r.value;
      pending.delete(name);
      progressed = true;
    }

    if (!progressed) break;
  }

  // Whatever is still pending cannot be resolved. Say which of the two reasons it is.
  //
  // A cycle has to be found by walking the dependency graph, not by checking whether an
  // expression mentions its own name. `a = b + 1` alongside `b = a + 1` is circular and
  // neither expression names itself; reporting "there is no parameter called b" for that is
  // true in a narrow sense and useless for fixing it.
  const dependsOn = new Map<string, string[]>();
  for (const [name, p] of pending) {
    dependsOn.set(name, evaluateExpr(String(p.value), values).uses);
  }

  const inCycle = (start: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(dependsOn.get(start) ?? [])];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === start) return true;
      if (seen.has(at) || !dependsOn.has(at)) continue;
      seen.add(at);
      stack.push(...(dependsOn.get(at) ?? []));
    }
    return false;
  };

  for (const [name, p] of pending) {
    if (inCycle(name)) {
      errors.set(name, `${name} is defined in terms of itself.`);
      continue;
    }
    const r = evaluateExpr(String(p.value), values);
    errors.set(name, r.error ?? `${name} depends on a parameter that could not be worked out.`);
  }

  return { values, errors };
}

/**
 * Reads a value that may be a literal, a parameter name, or an expression.
 *
 * The single entry point every parameter read goes through, so an expression works everywhere
 * a number does without each call site having to know.
 */
export function readNumber(
  raw: unknown, values: Record<string, number>, fallback: number,
): { value: number; error?: string } {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw };
  if (typeof raw !== 'string' || raw.trim() === '') return { value: fallback };

  const r = evaluateExpr(raw, values);
  return r.error ? { value: fallback, error: r.error } : { value: r.value };
}

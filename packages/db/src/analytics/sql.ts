/**
 * Parameterized SQL for the analytics queries (Postgres).
 *
 * `sql` is a tagged template: interpolated values become bind parameters
 * (`$1`, `$2`, …) and interpolated `Sql` fragments are spliced in with their
 * own parameters renumbered. Nothing user-controlled is ever concatenated
 * into the text, which replaces the `sqlstring.escape` calls the ClickHouse
 * queries used (its MySQL-style backslash escaping is not safe under
 * Postgres' standard_conforming_strings).
 *
 *   const where = sql`e.project_id = ${projectId} AND e.name = ANY(${names}::text[])`;
 *   const query = sql`SELECT count(*) FROM analytics.events e WHERE ${where}`;
 *   compile(query) // { text: 'SELECT … WHERE e.project_id = $1 AND …', values: [projectId, names] }
 */
export class Sql {
  /** `strings.length === values.length + 1`, like a template literal. */
  readonly strings: readonly string[];
  readonly values: readonly unknown[];

  constructor(strings: readonly string[], values: readonly unknown[]) {
    if (strings.length !== values.length + 1) {
      throw new Error('Sql: expected one more string than values');
    }
    // Flatten nested fragments so compile() is a single pass.
    const flatStrings: string[] = [strings[0]!];
    const flatValues: unknown[] = [];
    values.forEach((value, index) => {
      const next = strings[index + 1]!;
      if (value instanceof Sql) {
        flatStrings[flatStrings.length - 1] += value.strings[0]!;
        value.values.forEach((inner, innerIndex) => {
          flatValues.push(inner);
          flatStrings.push(value.strings[innerIndex + 1]!);
        });
        flatStrings[flatStrings.length - 1] += next;
      } else {
        flatValues.push(value);
        flatStrings.push(next);
      }
    });
    this.strings = flatStrings;
    this.values = flatValues;
  }

  /** True when the fragment has no text and no parameters. */
  get isEmpty(): boolean {
    return this.values.length === 0 && this.strings[0]!.trim() === '';
  }
}

export interface CompiledSql {
  text: string;
  values: unknown[];
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  return new Sql(strings, values);
}

/**
 * Trusted SQL text: keywords, operators, and identifiers chosen by our code
 * from a fixed set. Never pass request data through here.
 */
export function raw(text: string): Sql {
  return new Sql([text], []);
}

export const empty = raw('');

const IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * A quoted identifier, e.g. `ident('analytics', 'events')` →
 * `"analytics"."events"`. Rejects anything that isn't a plain identifier so
 * a slip can't turn it into an injection vector.
 */
export function ident(...parts: string[]): Sql {
  for (const part of parts) {
    if (!IDENTIFIER_PART.test(part)) {
      throw new Error(`Invalid SQL identifier: ${JSON.stringify(part)}`);
    }
  }
  return raw(parts.map((part) => `"${part}"`).join('.'));
}

/** Join fragments (and plain values, as parameters) with a separator. */
export function join(parts: readonly unknown[], separator = ', '): Sql {
  if (parts.length === 0) {
    return empty;
  }
  const strings = ['', ...Array.from({ length: parts.length - 1 }, () => separator), ''];
  return new Sql(strings, parts);
}

/** `a AND b AND …`, skipping empty fragments; `TRUE` when nothing is left. */
export function and(parts: readonly (Sql | null | undefined | false)[]): Sql {
  const present = parts.filter((part): part is Sql => part instanceof Sql && !part.isEmpty);
  if (present.length === 0) {
    return raw('TRUE');
  }
  if (present.length === 1) {
    return present[0]!;
  }
  return join(present.map((part) => sql`(${part})`), ' AND ');
}

/** `a OR b OR …`, skipping empty fragments; `FALSE` when nothing is left. */
export function or(parts: readonly (Sql | null | undefined | false)[]): Sql {
  const present = parts.filter((part): part is Sql => part instanceof Sql && !part.isEmpty);
  if (present.length === 0) {
    return raw('FALSE');
  }
  if (present.length === 1) {
    return present[0]!;
  }
  return join(present.map((part) => sql`(${part})`), ' OR ');
}

/** `column = ANY($n::text[])` — ClickHouse's `column IN (…)` for strings. */
export function anyOf(column: Sql, values: readonly string[]): Sql {
  return sql`${column} = ANY(${[...values]}::text[])`;
}

/**
 * A flattened event/profile property: `COALESCE(<alias>.properties->>$n, '')`.
 * A missing key reads as '' — ClickHouse's Map default — so filters such as
 * `prop('plan') = ''` keep their meaning.
 */
export function prop(key: string, source: Sql = raw('properties')): Sql {
  return sql`COALESCE(${source}->>${key}, '')`;
}

/** Compile a fragment into `$n` text and its parameter list. */
export function compile(fragment: Sql): CompiledSql {
  let text = fragment.strings[0]!;
  for (let index = 0; index < fragment.values.length; index++) {
    text += `$${index + 1}${fragment.strings[index + 1]!}`;
  }
  return { text, values: [...fragment.values] };
}

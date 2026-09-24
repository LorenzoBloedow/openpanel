import type { IInterval } from '@openpanel/validation';

import { anQuery } from './client';
import { type Sql, compile, empty, join, raw, sql } from './sql';
import {
  type TimeCtx,
  type TimeUnit,
  formatDate,
  formatDateTime,
  fromLocal,
  startOf,
} from './time';

/**
 * The Postgres successor of the ClickHouse `clix` builder, with the same
 * method names so services port with small diffs. Differences:
 *
 * - Values passed to `where`/`having` are bind parameters, never inlined.
 * - A wall-clock date string value ('YYYY-MM-DD[ HH:MM:SS]') is read in the
 *   project time zone — what ClickHouse's `session_timezone` did for string
 *   literals. `Date` values are instants.
 * - Column and condition strings are trusted SQL text, as before; build
 *   anything that contains request data with the `sql` tag instead.
 * - ClickHouse-only clauses are gone: `FINAL` and `SETTINGS` are ignored,
 *   `WITH FILL` is done by the caller (see gapFill), and `LEFT ANY JOIN`
 *   becomes a plain LEFT JOIN (callers join on unique keys).
 */

type SqlValue = string | number | boolean | Date | null | Sql;
type SqlParam = SqlValue | SqlValue[];
type Operator =
  | '='
  | '>'
  | '<'
  | '>='
  | '<='
  | '!='
  | 'IN'
  | 'NOT IN'
  | 'LIKE'
  | 'NOT LIKE'
  | 'ILIKE'
  | 'NOT ILIKE'
  | 'IS NULL'
  | 'IS NOT NULL'
  | 'BETWEEN';

type Fragment = string | Sql;
type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';

interface WhereCondition {
  condition: Sql;
  operator: 'AND' | 'OR';
  isGroup?: boolean;
}

type ConditionalCallback = (query: Query) => void;

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

const toSql = (fragment: Fragment): Sql =>
  typeof fragment === 'string' ? raw(fragment) : fragment;

export class Query<T = any> {
  private _select: Sql[] = [];
  private _distinctOn: Sql[] = [];
  private _from?: Sql;
  private _where: WhereCondition[] = [];
  private _groupBy: Sql[] = [];
  private _rollup = false;
  private _having: WhereCondition[] = [];
  private _orderBy: { column: Sql; direction: 'ASC' | 'DESC' }[] = [];
  private _limit?: number;
  private _offset?: number;
  private _ctes: { name: string; query: Sql }[] = [];
  private _joins: Sql[] = [];
  private _skipNext = false;
  private _transform?: Record<string, (item: T) => any>;
  private _unions: Query[] = [];

  constructor(readonly ctx: TimeCtx) {}

  // --- values --------------------------------------------------------------

  /** A bound value; wall-clock strings are read in the project zone. */
  value(value: SqlValue): Sql {
    if (value === null) {
      return raw('NULL');
    }
    if (typeof value === 'object' && !(value instanceof Date)) {
      return sql`(${value})`;
    }
    if (typeof value === 'string' && WALL_CLOCK.test(value)) {
      return fromLocal(value, this.ctx);
    }
    return sql`${value}`;
  }

  private list(values: SqlValue[] | Sql): Sql {
    if (!Array.isArray(values)) {
      return sql`(${values})`;
    }
    if (values.length === 0) {
      // `IN ()` is invalid; a NULL-only list matches nothing.
      return raw('(NULL)');
    }
    return sql`(${join(values.map((value) => this.value(value)))})`;
  }

  buildCondition(column: Fragment, operator: Operator, value?: SqlParam): Sql {
    const target = toSql(column);
    switch (operator) {
      case 'IS NULL':
        return sql`${target} IS NULL`;
      case 'IS NOT NULL':
        return sql`${target} IS NOT NULL`;
      case 'BETWEEN':
        if (Array.isArray(value) && value.length === 2) {
          return sql`${target} BETWEEN ${this.value(value[0]!)} AND ${this.value(value[1]!)}`;
        }
        throw new Error('BETWEEN operator requires an array of two values');
      case 'IN':
      case 'NOT IN': {
        if (Array.isArray(value)) {
          return sql`${target} ${raw(operator)} ${this.list(value)}`;
        }
        if (value && typeof value === 'object' && !(value instanceof Date)) {
          return sql`${target} ${raw(operator)} ${this.list(value)}`;
        }
        throw new Error(`${operator} operator requires an array value`);
      }
      default:
        if (Array.isArray(value) || value === undefined) {
          throw new Error(`${operator} operator requires a single value`);
        }
        return sql`${target} ${raw(operator)} ${this.value(value)}`;
    }
  }

  // --- select / from ---------------------------------------------------------

  select<U>(
    columns: (Fragment | null | undefined | false)[],
    type: 'merge' | 'replace' = 'replace',
  ): Query<U> {
    if (this._skipNext) {
      return this as unknown as Query<U>;
    }
    const next = columns
      .filter((column): column is Fragment => Boolean(column))
      .map(toSql);
    this._select = type === 'merge' ? [...this._select, ...next] : next;
    return this as unknown as Query<U>;
  }

  /** `SELECT DISTINCT ON (…)` — Postgres' argMax/`LIMIT 1 BY` workhorse. */
  distinctOn(columns: Fragment[]): this {
    this._distinctOn = columns.map(toSql);
    return this;
  }

  rollup(): this {
    this._rollup = true;
    return this;
  }

  /** `final` is accepted for API compatibility; Postgres tables have no FINAL. */
  from(table: Fragment | Query, _final = false): this {
    this._from =
      table instanceof Query ? sql`(${table.toSql()}) AS _sub` : toSql(table);
    return this;
  }

  union(query: Query): this {
    this._unions.push(query);
    return this;
  }

  with(name: string, query: Query | Fragment): this {
    this._ctes.push({
      name,
      query: query instanceof Query ? query.toSql() : toSql(query),
    });
    return this;
  }

  // --- where / having ---------------------------------------------------------

  where(column: Fragment, operator: Operator, value?: SqlParam): this {
    if (this._skipNext) {
      return this;
    }
    this._where.push({
      condition: this.buildCondition(column, operator, value),
      operator: 'AND',
    });
    return this;
  }

  andWhere(column: Fragment, operator: Operator, value?: SqlParam): this {
    return this.where(column, operator, value);
  }

  orWhere(column: Fragment, operator: Operator, value?: SqlParam): this {
    if (this._skipNext) {
      return this;
    }
    this._where.push({
      condition: this.buildCondition(column, operator, value),
      operator: 'OR',
    });
    return this;
  }

  rawWhere(condition: Fragment): this {
    if (this._skipNext) {
      return this;
    }
    const fragment = toSql(condition);
    if (!fragment.isEmpty) {
      this._where.push({ condition: fragment, operator: 'AND' });
    }
    return this;
  }

  whereGroup(): WhereGroupBuilder {
    return new WhereGroupBuilder(this, 'AND');
  }

  orWhereGroup(): WhereGroupBuilder {
    return new WhereGroupBuilder(this, 'OR');
  }

  _addWhereCondition(condition: WhereCondition): this {
    this._where.push(condition);
    return this;
  }

  groupBy(columns: (Fragment | null | undefined | false)[]): this {
    this._groupBy = columns
      .filter((column): column is Fragment => Boolean(column))
      .map(toSql);
    return this;
  }

  having(column: Fragment, operator: Operator, value: SqlParam): this {
    this._having.push({
      condition: this.buildCondition(column, operator, value),
      operator: 'AND',
    });
    return this;
  }

  andHaving(column: Fragment, operator: Operator, value: SqlParam): this {
    return this.having(column, operator, value);
  }

  orHaving(column: Fragment, operator: Operator, value: SqlParam): this {
    this._having.push({
      condition: this.buildCondition(column, operator, value),
      operator: 'OR',
    });
    return this;
  }

  rawHaving(condition: Fragment): this {
    const fragment = toSql(condition);
    if (!fragment.isEmpty) {
      this._having.push({ condition: fragment, operator: 'AND' });
    }
    return this;
  }

  // --- order / limit ------------------------------------------------------------

  orderBy(column: Fragment, direction: 'ASC' | 'DESC' = 'ASC'): this {
    if (this._skipNext) {
      return this;
    }
    this._orderBy.push({ column: toSql(column), direction });
    return this;
  }

  limit(limit?: number): this {
    if (limit !== undefined) {
      this._limit = limit;
    }
    return this;
  }

  offset(offset?: number): this {
    if (offset !== undefined) {
      this._offset = offset;
    }
    return this;
  }

  /** ClickHouse SETTINGS have no Postgres counterpart; kept as a no-op. */
  settings(_settings: Record<string, string>): this {
    return this;
  }

  // --- joins ----------------------------------------------------------------------

  private joinWithType(
    type: JoinType,
    table: Fragment | Query,
    condition: Fragment | undefined,
    alias?: string,
  ): this {
    if (this._skipNext) {
      return this;
    }
    const source =
      table instanceof Query ? sql`(${table.toSql()})` : toSql(table);
    const aliasSql = alias ? raw(` ${alias}`) : empty;
    const on = condition ? sql` ON ${toSql(condition)}` : empty;
    this._joins.push(sql`${raw(type)} JOIN ${source}${aliasSql}${on}`);
    return this;
  }

  join(table: Fragment | Query, condition: Fragment, alias?: string): this {
    return this.joinWithType('INNER', table, condition, alias);
  }

  innerJoin(table: Fragment | Query, condition: Fragment, alias?: string): this {
    return this.joinWithType('INNER', table, condition, alias);
  }

  leftJoin(table: Fragment | Query, condition: Fragment, alias?: string): this {
    return this.joinWithType('LEFT', table, condition, alias);
  }

  /**
   * ClickHouse's LEFT ANY JOIN kept one arbitrary match. Postgres has no
   * equivalent, so this is a LEFT JOIN: join on a unique key, or pass a
   * subquery that is already one row per key (DISTINCT ON).
   */
  leftAnyJoin(table: Fragment | Query, condition: Fragment, alias?: string): this {
    return this.joinWithType('LEFT', table, condition, alias);
  }

  rightJoin(table: Fragment | Query, condition: Fragment, alias?: string): this {
    return this.joinWithType('RIGHT', table, condition, alias);
  }

  fullJoin(table: Fragment | Query, condition: Fragment, alias?: string): this {
    return this.joinWithType('FULL', table, condition, alias);
  }

  crossJoin(table: Fragment | Query, alias?: string): this {
    return this.joinWithType('CROSS', table, undefined, alias);
  }

  /** A join clause written by hand, e.g. `CROSS JOIN LATERAL unnest(…)`. */
  rawJoin(clause: Fragment): this {
    if (this._skipNext) {
      return this;
    }
    this._joins.push(toSql(clause));
    return this;
  }

  // --- conditionals ---------------------------------------------------------------

  if(condition: unknown): this {
    this._skipNext = !condition;
    return this;
  }

  endIf(): this {
    this._skipNext = false;
    return this;
  }

  when(condition: boolean, callback?: ConditionalCallback): this {
    if (condition && callback) {
      callback(this);
    }
    return this;
  }

  clone(): Query<T> {
    return new Query<T>(this.ctx).merge(this);
  }

  merge(query: Query): this {
    if (this._skipNext) {
      return this;
    }
    this._from = query._from;
    this._select = [...this._select, ...query._select];
    this._distinctOn = [...this._distinctOn, ...query._distinctOn];
    this._where = [...this._where, ...query._where];
    this._ctes = [...this._ctes, ...query._ctes];
    this._joins = [...this._joins, ...query._joins];
    if (query._limit !== undefined) {
      this._limit =
        this._limit === undefined
          ? query._limit
          : Math.min(this._limit, query._limit);
    }
    this._orderBy = [...this._orderBy, ...query._orderBy];
    this._groupBy = [...this._groupBy, ...query._groupBy];
    this._having = [...this._having, ...query._having];
    this._rollup = this._rollup || query._rollup;
    return this;
  }

  transform(transformations: Record<string, (item: T) => any>): this {
    this._transform = transformations;
    return this;
  }

  // --- output ------------------------------------------------------------------------

  private conditions(conditions: WhereCondition[]): Sql {
    return join(
      conditions.map((condition, index) => {
        const body = condition.isGroup
          ? sql`(${condition.condition})`
          : condition.condition;
        return index === 0 ? body : sql`${raw(condition.operator)} ${body}`;
      }),
      ' ',
    );
  }

  /** The query as a parameterized fragment, for embedding or execution. */
  toSql(): Sql {
    const parts: Sql[] = [];

    if (this._ctes.length > 0) {
      parts.push(
        sql`WITH ${join(
          this._ctes.map((cte) => sql`${raw(cte.name)} AS (${cte.query})`),
        )}`,
      );
    }

    const distinct =
      this._distinctOn.length > 0
        ? sql`DISTINCT ON (${join(this._distinctOn)}) `
        : empty;
    parts.push(
      this._select.length > 0
        ? sql`SELECT ${distinct}${join(this._select)}`
        : sql`SELECT ${distinct}*`,
    );

    if (this._from) {
      parts.push(sql`FROM ${this._from}`);
      parts.push(...this._joins);
    }

    if (this._where.length > 0) {
      parts.push(sql`WHERE ${this.conditions(this._where)}`);
    }

    if (this._groupBy.length > 0) {
      parts.push(
        this._rollup
          ? sql`GROUP BY ROLLUP (${join(this._groupBy)})`
          : sql`GROUP BY ${join(this._groupBy)}`,
      );
    }

    if (this._having.length > 0) {
      parts.push(sql`HAVING ${this.conditions(this._having)}`);
    }

    if (this._orderBy.length > 0) {
      parts.push(
        sql`ORDER BY ${join(
          this._orderBy.map(
            (order) => sql`${order.column} ${raw(order.direction)}`,
          ),
        )}`,
      );
    }

    if (this._limit !== undefined) {
      parts.push(sql`LIMIT ${raw(String(Math.trunc(this._limit)))}`);
      if (this._offset !== undefined) {
        parts.push(sql`OFFSET ${raw(String(Math.trunc(this._offset)))}`);
      }
    }

    let query = join(parts, ' ');
    for (const union of this._unions) {
      query = sql`(${query}) UNION ALL (${union.toSql()})`;
    }
    return query;
  }

  /** The compiled text, for logs and tests. */
  toSQL(): string {
    return compile(this.toSql()).text;
  }

  async execute(): Promise<T[]> {
    const rows = await anQuery<Record<string, any>>(this.toSql());
    if (!this._transform) {
      return rows as T[];
    }
    const transform = this._transform;
    return rows.map((row) => {
      const next: Record<string, any> = { ...row };
      for (const [key, fn] of Object.entries(transform)) {
        next[key] = fn(row as T);
      }
      return next as T;
    });
  }
}

export class WhereGroupBuilder {
  private conditions: WhereCondition[] = [];

  constructor(
    private query: Query,
    private groupOperator: 'AND' | 'OR',
  ) {}

  where(column: Fragment, operator: Operator, value?: SqlParam): this {
    this.conditions.push({
      condition: this.query.buildCondition(column, operator, value),
      operator: 'AND',
    });
    return this;
  }

  andWhere(column: Fragment, operator: Operator, value?: SqlParam): this {
    return this.where(column, operator, value);
  }

  orWhere(column: Fragment, operator: Operator, value?: SqlParam): this {
    this.conditions.push({
      condition: this.query.buildCondition(column, operator, value),
      operator: 'OR',
    });
    return this;
  }

  rawWhere(condition: Fragment): this {
    this.conditions.push({ condition: toSql(condition), operator: 'AND' });
    return this;
  }

  end(): Query {
    const condition = join(
      this.conditions.map((entry, index) =>
        index === 0
          ? entry.condition
          : sql`${raw(entry.operator)} ${entry.condition}`,
      ),
      ' ',
    );
    this.query._addWhereCondition({
      condition,
      operator: this.groupOperator,
      isGroup: true,
    });
    return this.query;
  }
}

/** A new query whose wall-clock values and buckets use `timezone`. */
export function clix(timezone?: string): Query {
  return new Query({ timezone: timezone ?? 'UTC' });
}

/** Embed a subquery or trusted SQL text as a fragment. */
clix.exp = (expression: string | Query<any> | Sql): Sql =>
  expression instanceof Query ? expression.toSql() : toSql(expression);

clix.date = (date: string | Date): string =>
  new Date(date).toISOString().slice(0, 10);

clix.datetime = (date: string | Date): string =>
  new Date(date).toISOString().slice(0, 19).replace('T', ' ');

clix.dynamicDatetime = (date: string | Date, interval: IInterval) =>
  interval === 'month' || interval === 'week'
    ? clix.date(date)
    : clix.datetime(date);

const INTERVAL_UNITS: Record<IInterval, TimeUnit> = {
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
};

/**
 * The bucket an instant column falls into, as project wall-clock time
 * (`timestamp`) — ClickHouse's toStartOf{Minute,Hour,Day,Week,Month}.
 */
clix.toStartOf = (node: Fragment, interval: IInterval, ctx: TimeCtx): Sql =>
  startOf(toSql(node), INTERVAL_UNITS[interval], ctx);

/**
 * A bucket rendered the way ClickHouse returned it: toStartOfWeek/Month gave
 * a Date ('YYYY-MM-DD'), the finer ones a DateTime ('YYYY-MM-DD HH:MM:SS').
 */
clix.formatBucket = (bucket: Sql, interval: IInterval): Sql =>
  interval === 'week' || interval === 'month'
    ? formatDate(bucket)
    : formatDateTime(bucket);

clix.formatDate = formatDate;
clix.formatDateTime = formatDateTime;

// Export types
export type { SqlValue, SqlParam, Operator };

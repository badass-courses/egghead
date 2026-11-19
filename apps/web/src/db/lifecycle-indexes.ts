import { is, type BuildColumns } from "drizzle-orm";
import {
  index,
  MySqlColumn,
  type MySqlColumnBuilderBase,
  type MySqlTableExtraConfig,
  type MySqlTableFn,
} from "drizzle-orm/mysql-core";
import type { MySqlColumnBuilders } from "drizzle-orm/mysql-core/columns/all";

/**
 * Indexes the published CourseBuilder schema lacks, on the columns the
 * subscription read paths and webhook lookups join on. Without them
 * `getCurrentSubscriptionForUser`'s customer branch, `getBillingSubscriptionForUser`
 * and the pre-lock webhook lookup scan whole tables on every request (see
 * `tests/behaviors/subscriptions.md`, "Read paths"). Keyed by unprefixed table
 * name; each entry is index name → column.
 */
export const LIFECYCLE_INDEXES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Subscription: { merchantSubscriptionId_idx: "merchantSubscriptionId" },
  MerchantSubscription: {
    merchantCustomerId_idx: "merchantCustomerId",
    identifier_idx: "identifier",
  },
};

function lifecycleIndexes(name: string, self: object): MySqlTableExtraConfig {
  const wanted = LIFECYCLE_INDEXES[name];
  if (!wanted) return {};
  return Object.fromEntries(
    Object.entries(wanted).map(([indexName, columnName]) => {
      const column: unknown = Reflect.get(self, columnName);
      // A renamed or dropped upstream column must fail the build, not skip the index.
      if (!is(column, MySqlColumn))
        throw new Error(`CourseBuilder's ${name} table has no ${columnName} column to index.`);
      return [indexName, index(indexName).on(column)];
    }),
  );
}

/**
 * Wrap a Drizzle table factory so the CourseBuilder schema it builds carries
 * `LIFECYCLE_INDEXES` next to its own constraints. Every other table, and every
 * upstream column, constraint and index, passes through unchanged.
 */
export function withLifecycleIndexes(base: MySqlTableFn): MySqlTableFn {
  function table<
    TTableName extends string,
    TColumnsMap extends Record<string, MySqlColumnBuilderBase>,
  >(
    name: TTableName,
    columns: TColumnsMap | ((columnTypes: MySqlColumnBuilders) => TColumnsMap),
    extraConfig?: (self: BuildColumns<TTableName, TColumnsMap, "mysql">) => MySqlTableExtraConfig,
  ) {
    const config = (self: BuildColumns<TTableName, TColumnsMap, "mysql">) => ({
      ...extraConfig?.(self),
      ...lifecycleIndexes(name, self),
    });
    return typeof columns === "function"
      ? base(name, columns, config)
      : base(name, columns, config);
  }
  return table;
}

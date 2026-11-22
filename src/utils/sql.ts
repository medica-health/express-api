// Tiny helper for building parameterised SQL with optional filters:
//   const b = new SqlBuilder();
//   if (city) b.where(`lower(c.city) = lower(${b.param(city)})`);
//   pool.query(`SELECT ... ${b.whereClause()}`, b.params)
export class SqlBuilder {
  readonly params: unknown[] = [];
  private readonly conditions: string[] = [];

  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  where(condition: string): this {
    this.conditions.push(condition);
    return this;
  }

  whereClause(prefix = "WHERE"): string {
    return this.conditions.length ? `${prefix} ${this.conditions.join(" AND ")}` : "";
  }
}

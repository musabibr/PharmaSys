/** Minimal ambient declaration so TypeScript accepts sql.js without @types/sql.js */
declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }
  interface Database {
    run(sql: string, params?: any[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }
  interface Statement {
    step(): boolean;
    getAsObject(params?: any): Record<string, SqlValue>;
    bind(params?: any[]): boolean;
    free(): boolean;
    reset(): void;
  }
  interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }
  type SqlValue = string | number | null | Uint8Array;
  function initSqlJs(config?: any): Promise<SqlJsStatic>;
  export = initSqlJs;
}

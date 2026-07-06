export { observeDialect, ObservedDialect } from './observed-dialect.js';
export type { KyselyOtelOptions } from './options.js';
export type { QueryContext } from './analysis/analyze.js';
export { VERSION } from './version.js';
export {
  ATTR_ACQUIRE_DURATION,
  ATTR_AFFECTED_ROWS,
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION,
  ATTR_DB_QUERY_FINGERPRINT,
  ATTR_DB_QUERY_HASH,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM,
  ATTR_ERROR_TYPE,
  ATTR_PARAMETER_COUNT,
  ATTR_RAW,
  ATTR_RETURNED_ROWS,
  ATTR_SANITIZATION_ERROR,
  ATTR_TABLES,
  ATTR_TRANSACTION_OUTCOME,
} from './otel/attributes.js';

// Advanced filter engine for GET /api/:resource?filters=<json>  (P1-BE2-04)
//
// The payload is JSON-encoded on the query string and is either a field
// condition or a logical group:
//
//   { "field": "status", "operator": "eq", "value": "open" }
//   { "$and": [ <condition>, ... ] }
//   { "$or":  [ <condition>, ... ] }
//
// "$and"/"$or" and "AND"/"OR" are accepted interchangeably. Groups nest to
// any depth. Anything that fails validation raises FilterError, which the
// list handler turns into a 400.

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "starts_with",
  "gt",
  "lt",
  "is_set",
];

const LOGICAL_KEYS = ["$and", "$or", "AND", "OR"];
const CONDITION_KEYS = ["field", "operator", "value"];

// is_set is a presence test, so it needs no value to compare against.
const OPERATORS_WITHOUT_VALUE = new Set(["is_set"]);

export class FilterError extends Error {
  constructor(message) {
    super(message);
    this.name = "FilterError";
    this.status = 400;
  }
}

const isPlainObject = value =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Present and carrying something: 0 and false are set values, "" / [] / {} /
// null / undefined are not.
const isBlank = value =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (isPlainObject(value) && Object.keys(value).length === 0);

const isPresent = (record, field) =>
  Object.prototype.hasOwnProperty.call(record, field) && !isBlank(record[field]);

const NUMERIC = /^-?\d+(\.\d+)?$/;

// gt/lt accept numbers and dates. Bare numbers win over dates so that "2024"
// compares as 2024 rather than as a year timestamp. Strings only get read as
// dates when they carry a date-ish separator, which stops Date.parse from
// swallowing ordinary words.
const toComparable = value => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { kind: "number", num: value } : null;
  }

  if (typeof value === "string") {
    const text = value.trim();

    if (NUMERIC.test(text)) return { kind: "number", num: Number(text) };

    if (/[-/:]/.test(text)) {
      const time = Date.parse(text);
      if (!Number.isNaN(time)) return { kind: "number", num: time };
    }

    return { kind: "text", text: value };
  }

  return null;
};

// -1 / 0 / 1, or null when the two values are not comparable.
const compareValues = (actual, expected) => {
  const left = toComparable(actual);
  const right = toComparable(expected);

  if (!left || !right || left.kind !== right.kind) return null;
  if (left.kind === "number")
    return left.num === right.num ? 0 : left.num < right.num ? -1 : 1;

  return left.text === right.text
    ? 0
    : left.text < right.text
      ? -1
      : 1;
};

const asText = value =>
  value === null || value === undefined ? null : String(value).toLowerCase();

const OPERATOR_FNS = {
  eq: (record, field, value) => record[field] === value,
  neq: (record, field, value) => record[field] !== value,
  contains: (record, field, value) => {
    const actual = asText(record[field]);
    const expected = asText(value);
    return actual !== null && expected !== null && actual.includes(expected);
  },
  starts_with: (record, field, value) => {
    const actual = asText(record[field]);
    const expected = asText(value);
    return actual !== null && expected !== null && actual.startsWith(expected);
  },
  gt: (record, field, value) => compareValues(record[field], value) === 1,
  lt: (record, field, value) => compareValues(record[field], value) === -1,
  is_set: (record, field) => isPresent(record, field),
};

const validateCondition = (condition, path) => {
  if (!isPlainObject(condition))
    throw new FilterError(`${path} must be an object`);

  for (const key of Object.keys(condition))
    if (!CONDITION_KEYS.includes(key))
      throw new FilterError(
        `${path} has unknown key "${key}"; expected field, operator, value`,
      );

  const { field, operator } = condition;

  if (typeof field !== "string" || field.trim() === "")
    throw new FilterError(`${path}.field must be a non-empty string`);

  if (typeof operator !== "string" || operator.trim() === "")
    throw new FilterError(`${path}.operator must be a non-empty string`);

  if (!FILTER_OPERATORS.includes(operator))
    throw new FilterError(
      `${path}.operator "${operator}" is not supported; expected one of ${FILTER_OPERATORS.join(", ")}`,
    );

  if (!OPERATORS_WITHOUT_VALUE.has(operator) && !("value" in condition))
    throw new FilterError(`${path}.value is required for operator "${operator}"`);
};

const validateNode = (node, path) => {
  if (!isPlainObject(node))
    throw new FilterError(`${path} must be an object`);

  const keys = Object.keys(node);

  if (keys.length === 0) throw new FilterError(`${path} must not be empty`);

  const logical = keys.filter(key => LOGICAL_KEYS.includes(key));

  if (logical.length > 1)
    throw new FilterError(
      `${path} combines ${logical.join(" and ")}; use only one logical operator per group`,
    );

  if (logical.length === 1) {
    const key = logical[0];
    const stray = keys.filter(k => !LOGICAL_KEYS.includes(k));

    if (stray.length)
      throw new FilterError(
        `${path} mixes "${key}" with condition key(s) ${stray.map(k => `"${k}"`).join(", ")}`,
      );

    const branches = node[key];

    if (!Array.isArray(branches))
      throw new FilterError(`${path}.${key} must be an array of conditions`);

    if (branches.length === 0)
      throw new FilterError(`${path}.${key} must contain at least one condition`);

    branches.forEach((branch, index) =>
      validateNode(branch, `${path}.${key}[${index}]`),
    );

    return;
  }

  validateCondition(node, path);
};

// Parses and fully validates the query-string payload up front, so the list
// handler never has to defend against a half-valid schema while filtering.
export const parseFilters = raw => {
  if (typeof raw !== "string")
    throw new FilterError("filters must be a JSON-encoded string");

  if (raw.trim() === "") throw new FilterError("filters must not be empty");

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FilterError(`filters is not valid JSON: ${error.message}`);
  }

  validateNode(parsed, "filters");

  return parsed;
};

export const matchesFilter = (record, node) => {
  const key = Object.keys(node).find(k => LOGICAL_KEYS.includes(k));

  if (key) {
    const branches = node[key];

    return key === "$or" || key === "OR"
      ? branches.some(branch => matchesFilter(record, branch))
      : branches.every(branch => matchesFilter(record, branch));
  }

  return OPERATOR_FNS[node.operator](record, node.field, node.value);
};

export const applyFilters = (rows, schema) =>
  schema ? rows.filter(row => matchesFilter(row, schema)) : rows;
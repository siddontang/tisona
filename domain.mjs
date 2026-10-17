import { digest } from './config.mjs';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function check(condition, message, status = 400) { if (!condition) throw new ApiError(status, message); }
export function validateFunction(body) {
  check(body && typeof body === 'object', 'Function descriptor is required');
  check(typeof body.name === 'string' && /^[\w.-]{1,128}$/.test(body.name), 'Invalid function name');
  check(Number.isInteger(body.version) && body.version > 0 && body.version < 2147483647, 'Invalid function version');
  check(typeof body.group === 'string' && /^[\w.-]{1,128}$/.test(body.group), 'Invalid worker group');
  check(typeof body.description === 'string' && body.description.length <= 4000, 'Invalid description');
  check(body.inputSchema && typeof body.inputSchema === 'object' && !Array.isArray(body.inputSchema), 'inputSchema must be a JSON Schema object');
  return { name: body.name, version: body.version, group: body.group, description: body.description, inputSchema: body.inputSchema };
}

// A deliberately small JSON Schema subset. Descriptors requiring unsupported
// keywords are rejected at registration rather than silently under-validated.
const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'description', 'title', 'default']);
export function validateSchema(schema) {
  check(schema && typeof schema === 'object' && !Array.isArray(schema), 'Invalid input schema');
  for (const key of Object.keys(schema)) check(schemaKeys.has(key), `Unsupported schema keyword: ${key}`);
  check(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type), 'Schema requires a supported type');
  if (schema.properties) for (const item of Object.values(schema.properties)) validateSchema(item);
  if (schema.items) validateSchema(schema.items);
  if (schema.required) check(Array.isArray(schema.required) && schema.required.every(x => typeof x === 'string'), 'Invalid required list');
  if (schema.additionalProperties !== undefined) check(typeof schema.additionalProperties === 'boolean', 'additionalProperties must be boolean');
  if (schema.enum) check(Array.isArray(schema.enum), 'enum must be an array');
}
export function validateInput(value, schema, path = 'input') {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  check(schema.type === type || (schema.type === 'integer' && Number.isInteger(value)), `${path} must be ${schema.type}`);
  if (schema.enum) check(schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value)), `${path} is not an allowed value`);
  if (type === 'object') {
    for (const key of schema.required ?? []) check(Object.hasOwn(value, key), `${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateInput(item, schema.properties[key], `${path}.${key}`);
      else check(schema.additionalProperties !== false, `${path}.${key} is not allowed`);
    }
  }
  if (type === 'array' && schema.items) value.forEach((v, i) => validateInput(v, schema.items, `${path}[${i}]`));
  if (type === 'string') {
    if (schema.minLength !== undefined) check(value.length >= schema.minLength, `${path} is too short`);
    if (schema.maxLength !== undefined) check(value.length <= schema.maxLength, `${path} is too long`);
  }
  if (type === 'number') {
    check(Number.isFinite(value), `${path} must be finite`);
    if (schema.minimum !== undefined) check(value >= schema.minimum, `${path} is below minimum`);
    if (schema.maximum !== undefined) check(value <= schema.maximum, `${path} exceeds maximum`);
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function executionId(project, key) { return `${project}-${digest(key).slice(0, 40)}`; }

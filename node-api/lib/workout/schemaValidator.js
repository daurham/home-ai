import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadWorkoutConfig } from './config.js';

let validators = new WeakMap();

export function getSchemaValidator(schema = loadWorkoutConfig().schema) {
  const cached = validators.get(schema);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = ajv.compile(schema);
  validators.set(schema, compiled);
  return compiled;
}

export function validateWorkoutSchema(record, schema = loadWorkoutConfig().schema) {
  const validate = getSchemaValidator(schema);
  const valid = Boolean(validate(record));
  const schemaErrors = (validate.errors || []).map((err) => ({
    instancePath: err.instancePath || '/',
    message: err.message,
    keyword: err.keyword,
    params: err.params,
  }));
  return { valid, schemaErrors };
}

import { Ajv } from 'ajv';
import type { Json } from '../domain/model.js';
import type { SchemaCompiler } from '../application/ports.js';

export class AjvSchemas implements SchemaCompiler {
  #ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, logger: false, addUsedSchema: false });
  compile(schema: Json): (value: unknown) => boolean {
    if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) throw new Error('invalid_tool_schema');
    try {
      const validate = this.#ajv.compile(schema);
      if ('$async' in validate && validate.$async) throw new Error('async_schema_unsupported');
      return value => validate(value) === true;
    } catch { throw new Error('invalid_tool_schema'); }
  }
}

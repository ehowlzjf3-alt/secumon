import { z } from 'zod';
import type { Json } from '../domain/model.js';
import { asJson } from './plan-validator.js';

/** Keep input defaults optional and express scalar unions in the existing strict draft-7 compiler's form. */
export function toolInputSchema(schema: z.ZodType): Json {
  const strictUnions = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(strictUnions);
    if (value === null || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strictUnions(item)]));
    if (Array.isArray(result.type) && result.type.filter(type => type !== 'null').length > 1) {
      result.anyOf = result.type.map(type => ({ type }));
      delete result.type;
    }
    return result;
  };
  return strictUnions(asJson(z.toJSONSchema(schema, { target: 'draft-7', io: 'input' })));
}

type JsonSchema = Record<string, unknown>;
const object = (value: unknown): JsonSchema => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchema : {};

/** Provider function arguments require one object at the root. Zod action
 * unions instead export root anyOf/oneOf, which some native APIs reject even
 * with strict=false. This is only a transport projection: the original Zod
 * action schema remains authoritative before any tool is executed. */
export function companionProviderToolParameters(input: object): JsonSchema {
  const schema = { ...input } as JsonSchema;
  delete schema.$schema;
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (!alternatives) return schema;
  const variants = alternatives.map(value => companionProviderToolParameters(object(value)));
  if (variants.some(value => value.type !== 'object')) throw new Error('Native companion tool alternatives must all be objects.');
  const fields = new Map<string, unknown[]>();
  for (const variant of variants) for (const [key, value] of Object.entries(object(variant.properties))) {
    const values = fields.get(key) ?? [];
    if (!values.some(existing => JSON.stringify(existing) === JSON.stringify(value))) values.push(value);
    fields.set(key, values);
  }
  const properties: JsonSchema = { ...object(schema.properties) };
  for (const [key, values] of fields) {
    if (values.length === 1) properties[key] = values[0];
    else if (values.every(value => Object.hasOwn(object(value), 'const'))) {
      properties[key] = { type: object(values[0]).type, enum: values.map(value => object(value).const) };
    } else properties[key] = { anyOf: values };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  for (const key of Array.isArray(variants[0]?.required) ? variants[0].required as string[] : []) {
    if (variants.every(value => Array.isArray(value.required) && value.required.includes(key))) required.add(key);
  }
  delete schema.anyOf; delete schema.oneOf;
  return { ...schema, type: 'object', properties, required: [...required], additionalProperties: false };
}

/**
 * Tool contracts: JSON Schema descriptors, argument validation and execution
 * result shapes.
 */

/**
 * A (deliberately small) subset of JSON Schema, which is all the Responses API
 * needs for function-tool parameters.
 */
export interface JSONSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  anyOf?: JSONSchema[];
  additionalProperties?: boolean | JSONSchema;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** Context handed to a tool implementation. */
export interface ToolContext {
  /** Aborted when the run is cancelled or the tool times out. */
  signal: AbortSignal | undefined;
  callId: string;
  /** 1-based ReAct step the tool was invoked in. */
  step: number;
  /** Emit a progress note (wired to the agent's logger, if any). */
  log: (message: string) => void;
}

/** A tool the model can call. */
export interface ToolDefinition<Args = Record<string, unknown>, Result = unknown> {
  /** Must match `^[a-zA-Z0-9_-]{1,64}$` to be accepted by the API. */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: JSONSchema;
  /** Request strict schema adherence from the model (best effort). */
  strict?: boolean;
  execute(args: Args, context: ToolContext): Promise<Result> | Result;
}

/**
 * A tool with its generics erased, for heterogeneous collections.
 *
 * `execute` receives runtime-validated arguments, so the cast performed by
 * {@link defineTool} consumers is safe at the boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * Identity helper that preserves the concrete argument/result types of a tool
 * literal, giving type-safe `execute` bodies.
 */
export function defineTool<Args, Result>(
  definition: ToolDefinition<Args, Result>,
): ToolDefinition<Args, Result> {
  return definition;
}

/** Outcome of running a tool. Structurally identical to the agent's event payload. */
export interface ToolExecutionResult {
  callId: string;
  name: string;
  ok: boolean;
  /** Observation text returned to the model. */
  output: string;
  error?: string;
  args?: unknown;
  durationMs: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(type: NonNullable<JSONSchema['type']>, value: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

/**
 * Validate `value` against a {@link JSONSchema}.
 *
 * Supports the keywords a function-tool schema realistically uses: `type`,
 * `properties`, `required`, `items`, `enum`, `anyOf`, `additionalProperties`
 * and the simple numeric/string constraints. Unknown keywords are ignored,
 * which keeps the validator permissive rather than rejecting valid calls.
 */
export function validateAgainstSchema(
  schema: JSONSchema,
  value: unknown,
  path = 'arguments',
): string[] {
  const errors: string[] = [];

  if (schema.anyOf !== undefined && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some((branch) => validateAgainstSchema(branch, value, path).length === 0);
    if (!matched) errors.push(`${path}: does not match any allowed schema variant`);
    return errors;
  }

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}, received ${describeType(value)}`);
    return errors;
  }

  if (schema.enum !== undefined && schema.enum.length > 0) {
    const allowed = schema.enum.some((candidate) => candidate === value);
    if (!allowed) {
      errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} characters`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => {
      errors.push(...validateAgainstSchema(schema.items as JSONSchema, entry, `${path}[${index}]`));
    });
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};

    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) {
        errors.push(`${path}.${key}: required property is missing`);
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      const entry = record[key];
      if (entry === undefined) continue;
      errors.push(...validateAgainstSchema(propertySchema, entry, `${path}.${key}`));
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  return errors;
}

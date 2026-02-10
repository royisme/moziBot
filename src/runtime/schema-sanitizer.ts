import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { logger } from "../logger";

type SchemaObject = Record<string, unknown>;

interface SanitizeResult {
  schema: TSchema;
  modified: boolean;
  removedKeywords: string[];
}

const GEMINI_UNSUPPORTED_KEYWORDS = [
  "$schema",
  "$id",
  "examples",
  "default",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "if",
  "then",
  "else",
  "not",
  "oneOf",
  "anyOf",
] as const;

function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convertAnyOfConstToEnum(schema: SchemaObject): SchemaObject | null {
  if (!Array.isArray(schema.anyOf)) {
    return null;
  }

  const constValues: string[] = [];
  for (const item of schema.anyOf) {
    if (isPlainObject(item) && item.const !== undefined && typeof item.const === "string") {
      constValues.push(item.const);
    } else {
      return null;
    }
  }

  if (constValues.length === 0) {
    return null;
  }

  return {
    type: "string",
    enum: constValues,
    ...(schema.description && { description: schema.description }),
  };
}

function convertPatternPropertiesToAdditionalProperties(schema: SchemaObject): boolean {
  if (!isPlainObject(schema.patternProperties)) {
    return false;
  }

  const patternProps = schema.patternProperties as Record<string, unknown>;
  const patterns = Object.keys(patternProps);

  if (patterns.length === 1) {
    const pattern = patterns[0];
    if (pattern === "^.*$" || pattern === "^(.*)$") {
      schema.additionalProperties = patternProps[pattern];
      delete schema.patternProperties;
      return true;
    }
  }

  if (patterns.length > 0) {
    delete schema.patternProperties;
    return true;
  }

  return false;
}

function sanitizeSchemaRecursive(schema: unknown): SanitizeResult {
  if (!isPlainObject(schema)) {
    return { schema: schema as TSchema, modified: false, removedKeywords: [] };
  }

  const cloned = structuredClone(schema);
  let modified = false;
  const removedKeywords: string[] = [];

  const anyOfEnumResult = convertAnyOfConstToEnum(cloned);
  if (anyOfEnumResult) {
    // Replace entire anyOf structure with flat enum representation
    for (const key of Object.keys(cloned)) {
      delete cloned[key];
    }
    Object.assign(cloned, anyOfEnumResult);
    modified = true;
    removedKeywords.push("anyOf");
  } else if (Array.isArray(cloned.anyOf)) {
    // anyOf exists but cannot be converted to enum -- log and strip it
    logger.warn(
      { anyOfLength: cloned.anyOf.length },
      "Removing unconvertible anyOf from tool schema for Gemini compatibility",
    );
    delete cloned.anyOf;
    modified = true;
    removedKeywords.push("anyOf");
  }

  if (convertPatternPropertiesToAdditionalProperties(cloned)) {
    modified = true;
    removedKeywords.push("patternProperties");
  }

  for (const keyword of GEMINI_UNSUPPORTED_KEYWORDS) {
    if (keyword in cloned) {
      delete cloned[keyword];
      modified = true;
      if (!removedKeywords.includes(keyword)) {
        removedKeywords.push(keyword);
      }
    }
  }

  if (isPlainObject(cloned.properties)) {
    const properties = cloned.properties as Record<string, unknown>;
    for (const [propName, propSchema] of Object.entries(properties)) {
      const result = sanitizeSchemaRecursive(propSchema);
      if (result.modified) {
        properties[propName] = result.schema;
        modified = true;
        removedKeywords.push(...result.removedKeywords);
      }
    }
  }

  if (isPlainObject(cloned.items)) {
    const result = sanitizeSchemaRecursive(cloned.items);
    if (result.modified) {
      cloned.items = result.schema;
      modified = true;
      removedKeywords.push(...result.removedKeywords);
    }
  }

  if (isPlainObject(cloned.additionalProperties)) {
    const result = sanitizeSchemaRecursive(cloned.additionalProperties);
    if (result.modified) {
      cloned.additionalProperties = result.schema;
      modified = true;
      removedKeywords.push(...result.removedKeywords);
    }
  }

  return {
    schema: cloned as TSchema,
    modified,
    removedKeywords: [...new Set(removedKeywords)],
  };
}

export function sanitizeToolSchema(schema: TSchema): TSchema {
  const result = sanitizeSchemaRecursive(schema);
  return result.schema;
}

export function sanitizeTools(tools: AgentTool[]): AgentTool[] {
  const sanitized: AgentTool[] = [];
  const modifications: Array<{ toolName: string; removedKeywords: string[] }> = [];

  for (const tool of tools) {
    const result = sanitizeSchemaRecursive(tool.parameters);
    if (result.modified) {
      sanitized.push({
        ...tool,
        parameters: result.schema,
      });
      modifications.push({
        toolName: tool.name,
        removedKeywords: result.removedKeywords,
      });
    } else {
      sanitized.push(tool);
    }
  }

  if (modifications.length > 0) {
    logger.debug(
      {
        toolCount: modifications.length,
        modifications: modifications.map((m) => ({
          tool: m.toolName,
          removedKeywords: m.removedKeywords,
        })),
      },
      "Sanitized tool schemas for Gemini compatibility",
    );
  }

  return sanitized;
}

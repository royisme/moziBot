import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { SandboxExecutor } from "./sandbox/executor";
import { createExecTool } from "./sandbox/tool";
import { sanitizeToolSchema, sanitizeTools } from "./schema-sanitizer";

function createMockExecutor(): SandboxExecutor {
  return {
    exec: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    stop: async () => {},
    probe: async () => ({
      ok: true,
      mode: "off" as const,
      message: "mock",
      hints: [],
    }),
  };
}

describe("sanitizeToolSchema", () => {
  it("removes patternProperties and converts to additionalProperties", () => {
    const schema = Type.Object({
      env: Type.Record(Type.String(), Type.String()),
    });

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    expect(sanitizedObj.properties).toBeDefined();
    const envProp = (sanitizedObj.properties as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(envProp.patternProperties).toBeUndefined();
    expect(envProp.additionalProperties).toBeDefined();
    expect((envProp.additionalProperties as Record<string, unknown>).type).toBe("string");
  });

  it("converts anyOf with const literals to enum", () => {
    const schema = Type.Union([
      Type.Literal("idle"),
      Type.Literal("queued"),
      Type.Literal("running"),
    ]);

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    expect(sanitizedObj.anyOf).toBeUndefined();
    expect(sanitizedObj.type).toBe("string");
    expect(sanitizedObj.enum).toEqual(["idle", "queued", "running"]);
  });

  it("removes minLength keyword", () => {
    const schema = Type.String({ minLength: 1 });

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    expect(sanitizedObj.type).toBe("string");
    expect(sanitizedObj.minLength).toBeUndefined();
  });

  it("removes multiple unsupported keywords", () => {
    const schema = Type.Object({
      name: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z]+$" }),
      count: Type.Number({ minimum: 0, maximum: 100 }),
    });

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    const nameProp = (sanitizedObj.properties as Record<string, unknown>).name as Record<
      string,
      unknown
    >;
    expect(nameProp.minLength).toBeUndefined();
    expect(nameProp.maxLength).toBeUndefined();
    expect(nameProp.pattern).toBeUndefined();

    const countProp = (sanitizedObj.properties as Record<string, unknown>).count as Record<
      string,
      unknown
    >;
    expect(countProp.minimum).toBeUndefined();
    expect(countProp.maximum).toBeUndefined();
  });

  it("sanitizes nested schemas recursively", () => {
    const schema = Type.Object({
      nested: Type.Object({
        env: Type.Record(Type.String(), Type.String()),
        status: Type.Union([Type.Literal("active"), Type.Literal("inactive")]),
      }),
    });

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;
    const nestedProp = (sanitizedObj.properties as Record<string, unknown>).nested as Record<
      string,
      unknown
    >;
    const nestedProps = nestedProp.properties as Record<string, unknown>;

    const envProp = nestedProps.env as Record<string, unknown>;
    expect(envProp.patternProperties).toBeUndefined();
    expect(envProp.additionalProperties).toBeDefined();

    const statusProp = nestedProps.status as Record<string, unknown>;
    expect(statusProp.anyOf).toBeUndefined();
    expect(statusProp.type).toBe("string");
    expect(statusProp.enum).toEqual(["active", "inactive"]);
  });

  it("preserves supported keywords", () => {
    const schema = Type.Object({
      name: Type.String(),
      age: Type.Optional(Type.Number()),
      tags: Type.Array(Type.String()),
      metadata: Type.Record(Type.String(), Type.String()),
    });

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    expect(sanitizedObj.type).toBe("object");
    expect(sanitizedObj.properties).toBeDefined();
    expect(sanitizedObj.required).toBeDefined();
    expect(Array.isArray(sanitizedObj.required)).toBe(true);
  });

  it("handles clean schema without modifications", () => {
    const schema = Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    });

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    expect(sanitizedObj.type).toBe("object");
    expect(sanitizedObj.properties).toBeDefined();
    const unsupportedKeywords = new Set([
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
      "anyOf",
    ]);
    expect(Object.keys(sanitizedObj).filter((k) => unsupportedKeywords.has(k)).length).toBe(0);
  });

  it("sanitizes exec tool schema correctly", () => {
    const execTool = createExecTool({
      executor: createMockExecutor(),
      sessionKey: "test-session",
      agentId: "test-agent",
      workspaceDir: "/tmp",
    });

    const sanitized = sanitizeToolSchema(execTool.parameters);
    const sanitizedObj = sanitized as Record<string, unknown>;
    const props = sanitizedObj.properties as Record<string, unknown>;

    expect(props.env).toBeDefined();
    const envProp = props.env as Record<string, unknown>;
    expect(envProp.patternProperties).toBeUndefined();
    expect(envProp.additionalProperties).toBeDefined();

    const commandProp = props.command as Record<string, unknown>;
    expect(commandProp.minLength).toBeUndefined();
  });

  it("handles array items sanitization", () => {
    const schema = Type.Array(
      Type.Object({
        name: Type.String({ minLength: 1 }),
        value: Type.Record(Type.String(), Type.String()),
      }),
    );

    const sanitized = sanitizeToolSchema(schema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    expect(sanitizedObj.type).toBe("array");
    expect(sanitizedObj.items).toBeDefined();

    const items = sanitizedObj.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, unknown>;

    const nameProp = itemProps.name as Record<string, unknown>;
    expect(nameProp.minLength).toBeUndefined();

    const valueProp = itemProps.value as Record<string, unknown>;
    expect(valueProp.patternProperties).toBeUndefined();
    expect(valueProp.additionalProperties).toBeDefined();
  });

  it("does not mutate original schema", () => {
    const schema = Type.Object({
      env: Type.Record(Type.String(), Type.String()),
      command: Type.String({ minLength: 1 }),
    });

    sanitizeToolSchema(schema);

    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.env.patternProperties).toBeDefined();
    expect(props.command.minLength).toBe(1);
  });

  it("strips unconvertible anyOf and logs warning", () => {
    const schema = {
      anyOf: [{ type: "string" }, { type: "number" }],
    };

    const sanitized = sanitizeToolSchema(schema as unknown as import("@sinclair/typebox").TSchema);
    const sanitizedObj = sanitized as Record<string, unknown>;

    expect(sanitizedObj.anyOf).toBeUndefined();
  });
});

describe("sanitizeTools", () => {
  it("sanitizes multiple tools and logs modifications", () => {
    const tools: AgentTool[] = [
      createExecTool({
        executor: createMockExecutor(),
        sessionKey: "test-session",
        agentId: "test-agent",
        workspaceDir: "/tmp",
      }),
      {
        name: "clean_tool",
        label: "Clean",
        description: "A tool with clean schema",
        parameters: Type.Object({
          path: Type.String(),
        }),
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
      },
    ];

    const sanitized = sanitizeTools(tools);

    expect(sanitized.length).toBe(2);
    expect(sanitized[0].name).toBe("exec");
    expect(sanitized[1].name).toBe("clean_tool");

    const execParams = sanitized[0].parameters as Record<string, unknown>;
    const execProps = execParams.properties as Record<string, unknown>;
    const envProp = execProps.env as Record<string, unknown>;
    expect(envProp.patternProperties).toBeUndefined();
  });

  it("preserves tool metadata", () => {
    const tools: AgentTool[] = [
      {
        name: "test_tool",
        label: "Test",
        description: "Test tool",
        parameters: Type.Object({
          value: Type.Record(Type.String(), Type.String()),
        }),
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: {},
        }),
      },
    ];

    const sanitized = sanitizeTools(tools);

    expect(sanitized[0].name).toBe("test_tool");
    expect(sanitized[0].label).toBe("Test");
    expect(sanitized[0].description).toBe("Test tool");
    expect(sanitized[0].execute).toBe(tools[0].execute);
  });
});

import { z } from "zod";

const InputSchema = z.object({
  prompt: z.string(),
  sessionId: z.string().optional(),
  groupFolder: z.string(),
  isMain: z.boolean(),
});

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const inputString = Buffer.concat(chunks).toString("utf-8");

  try {
    const jsonInput = JSON.parse(inputString);
    const input = InputSchema.parse(jsonInput);

    // Mock response for now
    const output = {
      status: "success",
      result: `Echo: ${input.prompt} (group: ${input.groupFolder}, isMain: ${input.isMain})`,
      sessionId: input.sessionId || "new-session-id",
    };

    // Output with markers for robust parsing
    console.log("---MOZI_START---");
    console.log(JSON.stringify(output));
    console.log("---MOZI_END---");
  } catch (error) {
    const errorOutput = {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    console.log("---MOZI_START---");
    console.log(JSON.stringify(errorOutput));
    console.log("---MOZI_END---");
    process.exit(1);
  }
}

void main();

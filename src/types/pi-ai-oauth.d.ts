declare module "@mariozechner/pi-ai/oauth" {
  export type OpenAICodexOAuthCredentials = {
    access: string;
    refresh: string;
    expires: number;
  };

  export function loginOpenAICodex(options: {
    onAuth: (info: { url: string; instructions?: string }) => Promise<void>;
    onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
    onProgress: (message: string) => void;
  }): Promise<OpenAICodexOAuthCredentials>;
}

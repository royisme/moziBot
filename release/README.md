# Mozi Release Bundle

This bundle contains:

- `mozi` (CLI)
- `mozi-runtime` (runtime host)
- `package.json` (runtime metadata for embedded pi-coding-agent)
- `config.example.jsonc` (configuration template)

## Quick start

1. Copy binaries to your preferred bin directory.
2. Create config at `~/.mozi/config.jsonc` from `config.example.jsonc`.
3. Export provider/channel tokens in your shell:

```bash
export OPENAI_API_KEY=...
export TELEGRAM_BOT_TOKEN=...
export DISCORD_BOT_TOKEN=...
```

4. Bootstrap sandbox dependencies (if enabled in config):

```bash
mozi sandbox bootstrap --config ~/.mozi/config.jsonc
```

5. Run runtime:

```bash
mozi runtime start --daemon --config ~/.mozi/config.jsonc
```

6. Check status/logs:

```bash
mozi runtime status --config ~/.mozi/config.jsonc
mozi runtime logs -f --config ~/.mozi/config.jsonc
```

## Linux systemd user service

```bash
mozi runtime install --config ~/.mozi/config.jsonc
mozi runtime status --config ~/.mozi/config.jsonc
```

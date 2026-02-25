---
title: "Desktop Widget UI & Interaction Design"
summary: "Clarify voice vs text modes, define states, and align widget interactions with clear mental models."
---

# Desktop Widget UI & Interaction Design

## Context

The current widget blends two interaction styles:

- Voice input + voice output (STT/TTS).
- Text input + voice output (chat-like input, audio reply).

This hybrid is confusing because it violates user expectations for chat UX (text input typically expects text output) and hides state boundaries for voice capture (recording, transcribing, sending). This document proposes a clean separation of modes and clear, minimal UI surfaces for each.

## Goals

- Make interaction modes explicit and predictable.
- Reduce ambiguity in recording/streaming state.
- Make default behavior safe (no always-on listening by default).
- Preserve the lightweight, ambient nature of the widget.
- Support both Live2D and Orb renderers.

## Non-Goals

- Replacing the underlying STT/TTS providers.
- Adding full chat history or a full conversation view.
- Implementing wake-word detection in this widget (handled elsewhere if needed).

## Design Principles

- **Mode clarity**: Voice and Text are distinct modes with distinct affordances.
- **Safety by default**: Push-to-talk (PTT) as the default voice interaction.
- **Progressive disclosure**: advanced options (VAD, auto-voice output) are tucked away.
- **Status first**: listening/transcribing/thinking/speaking must be visually obvious.
- **Minimal surface**: one primary control area per mode.

## Interaction Modes

### 1) Voice Mode (primary)

**Input**: Voice
**Output**: Voice + subtitles

Default path:

- Press-and-hold PTT to capture.
- Release to finalize; short transcribe phase; send.
- Model replies are spoken and shown as subtitles.

Optional path:

- Continuous mode (VAD) toggle in settings.
- Auto-send after silence (silence window + max duration safeguard).

### 2) Text Mode

**Input**: Text
**Output**: Text (voice optional)

Default path:

- Text input + send.
- Reply shows as text in compact subtitle pane.
- Voice playback is opt-in via a play button on each reply.
  - No auto TTS in text mode by default.

## Input/Output Matrix

| Mode  | Input | Output (default)  | Output (optional) |
| ----- | ----- | ----------------- | ----------------- |
| Voice | Voice | Voice + subtitles | Text-only toggle  |
| Text  | Text  | Text              | Play voice button |

## State Model

### High-level states

- `idle`
- `listening` (PTT held / VAD active)
- `transcribing`
- `thinking`
- `speaking`
- `error`

### Connection states

- `connecting` / `connected` / `disconnected`

## UI Architecture

### Layout Zones

1. **Top Status Bar**
   - Connection status, mode label, mic/tts status indicators.
2. **Center Stage**
   - Live2D or Orb renderer, with motion responding to phase.
3. **Bottom Control Dock**
   - Mode-specific input controls.

### Voice Mode Controls

- Primary PTT button (large circle).
- Inline status text ("Hold to talk", "Listening", "Transcribing", "Sending").
- Small toggle chip for Continuous mode (off by default).

### Text Mode Controls

- Single-line input field with send button.
- Optional voice playback button per assistant reply.

### Subtitles / Reply Pane

- Compact, single-message display with fade-out.
- For voice mode: shows transcript while recording + final reply subtitle.
- For voice mode: keep final user transcript visible until the assistant reply arrives.
- For text mode: shows last assistant reply, with optional play control (manual).

## Animation / Motion

- **Voice capture**: pulse ring on avatar, amplitude tied to mic level.
- **Thinking**: slow orbital or glow.
- **Speaking**: stronger amplitude pulses.
- **Error**: brief shake + red tint.

## Safety & Privacy Defaults

- Default to PTT (not continuous listening).
- Continuous listening is opt-in and visibly indicated.
- Mic permissions denied → show clear “Enable microphone” action.

## Accessibility

- Keyboard shortcut for PTT (Space or configurable).
- High-contrast focus states for controls.
- Text size scaling via OS settings.

## OpenClaw Reference (Behavioral Parallels)

OpenClaw’s mac voice overlay design provides useful patterns:

- **Explicit capture modes**: wake-word vs push-to-talk are separate. PTT does not require wake words.
- **Overlay lifecycle**: visible only during capture; auto-dismiss on send or empty transcript.
- **Tokenized sessions**: drop stale callbacks to avoid UI stuck states.
- **Clear transitions**: listening → transcribing → sending are tracked and logged.

These patterns support a predictable voice interaction model. We should replicate the **PTT-first default** and **explicit lifecycle** in the widget.

## Technical Touchpoints

- Widget already consumes `/events`, `/audio`, `/inbound`.
- Consider a new endpoint for `widget-config` to carry:
  - `mode` (voice/text)
  - `voiceInputMode` (ptt/vad)
  - `voiceOutputEnabled` (true/false)
  - `textOutputEnabled` (true/false)

## Risks & Mitigations

- **Confusion about mixed mode** → strict mode separation.
- **Always-on mic privacy** → PTT default + explicit UI indicator.
- **Voice output fatigue** → default to opt-in voice in text mode.

## Success Criteria

- Users can describe the widget behavior in one sentence ("Hold to talk" or "Type and send").
- No ambiguous state in voice capture (listening/transcribing/speaking visible).
- Mode switching does not change the user’s expectation mid-session.

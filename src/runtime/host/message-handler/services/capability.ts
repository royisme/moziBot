/**
 * Capability and Input Routing Service
 * 
 * Manages agent input modality capabilities and auto-switching/degradation logic.
 */

export type ModalityInput = 'image' | 'audio' | 'video' | 'file';
export type MediaType = 'photo' | 'video' | 'audio' | 'document' | 'voice';

export interface MediaItem {
  readonly type: MediaType;
  readonly mediaId: string;
}

export interface InputCapabilityDeps {
  readonly logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  readonly agentManager: {
    getAgent(sessionKey: string, agentId: string): Promise<{ modelRef: string }>;
    ensureSessionModelForInput(params: {
      sessionKey: string;
      agentId: string;
      input: ModalityInput;
    }): Promise<{
      ok: boolean;
      switched: boolean;
      modelRef: string;
      candidates: string[];
    }>;
  };
  readonly channel: {
    send(peerId: string, payload: { text: string }): Promise<void>;
  };
}

export interface InputCapabilityResult {
  readonly ok: boolean;
  readonly restoreModelRef?: string;
}

/**
 * Maps raw media types to internal input modalities.
 */
export function mediaTypeToInput(type: MediaType): ModalityInput {
  if (type === 'photo') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio' || type === 'voice') return 'audio';
  return 'file';
}

/**
 * Returns a human-readable description of an input modality.
 */
export function describeInput(input: ModalityInput): string {
  return input;
}

/**
 * Provides a configuration hint for resolving unsupported input modalities.
 */
export function modelConfigHint(agentId: string, input: ModalityInput): string {
  if (input === 'image') {
    return `agents.${agentId}.imageModel (or agents.defaults.imageModel)`;
  }
  return 'media understanding pipeline (transcription/description)';
}

/**
 * Checks if the current agent/model supports the required input modalities.
 * Performs auto-switching if enabled or notifies user of degradation.
 */
export async function checkInputCapability(params: {
  sessionKey: string;
  agentId: string;
  media: readonly MediaItem[];
  peerId: string;
  hasAudioTranscript: boolean;
  deps: InputCapabilityDeps;
}): Promise<InputCapabilityResult> {
  const { sessionKey, agentId, media, peerId, hasAudioTranscript, deps } = params;

  if (media.length === 0) {
    return { ok: true };
  }

  const currentBeforeRouting = await deps.agentManager.getAgent(sessionKey, agentId);
  const restoreModelRef = currentBeforeRouting.modelRef;
  let switched = false;

  const requiredInputs = Array.from(
    new Set(media.map((item) => mediaTypeToInput(item.type)))
  );

  for (const input of requiredInputs) {
    // 1. Skip audio degradation if a transcript already exists
    if (input === 'audio' && hasAudioTranscript) {
      deps.logger.info(
        { sessionKey, agentId, mediaCount: media.length, input },
        'Skipping audio capability degradation because transcript is available'
      );
      continue;
    }

    // 2. Ensure session has a model capable of handling this input
    const routed = await deps.agentManager.ensureSessionModelForInput({
      sessionKey,
      agentId,
      input,
    });

    if (routed.ok) {
      if (routed.switched) {
        switched = true;
        deps.logger.info(
          { sessionKey, agentId, modelRef: routed.modelRef, mediaCount: media.length, input },
          'Input capability auto-switched model'
        );
      }
      continue;
    }

    // 3. Handle degradation if no capable model found
    const suggestText = routed.candidates.length > 0
      ? `\nAvailable ${describeInput(input)} models:\n${routed.candidates.map((ref) => `- ${ref}`).join('\n')}`
      : '';

    await deps.channel.send(peerId, {
      text: `Current model ${routed.modelRef} does not support ${describeInput(input)} input. Continuing with text degradation. Configure ${modelConfigHint(agentId, input)} or manually /switch to a model that supports ${input}. ${suggestText}`,
    });

    deps.logger.warn(
      { sessionKey, agentId, modelRef: routed.modelRef, mediaCount: media.length, candidates: routed.candidates, input },
      'Input capability degraded to text'
    );
  }

  return { 
    ok: true, 
    restoreModelRef: switched ? restoreModelRef : undefined 
  };
}

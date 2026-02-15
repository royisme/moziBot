/**
 * AudioWorklet processor that converts float32 input to PCM s16le
 * and posts the result back to the main thread.
 *
 * Buffers frames internally to match ~4096 samples per chunk (~256ms at 16kHz),
 * keeping parity with the old ScriptProcessorNode behavior.
 */
class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(4096);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];
    let i = 0;

    while (i < samples.length) {
      const remaining = this._buffer.length - this._offset;
      const toCopy = Math.min(remaining, samples.length - i);
      this._buffer.set(samples.subarray(i, i + toCopy), this._offset);
      this._offset += toCopy;
      i += toCopy;

      if (this._offset >= this._buffer.length) {
        const pcm16 = new Int16Array(this._buffer.length);
        for (let j = 0; j < this._buffer.length; j++) {
          const s = Math.max(-1, Math.min(1, this._buffer[j]));
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-worklet-processor", PcmWorkletProcessor);

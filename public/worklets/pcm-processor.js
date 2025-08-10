// 16 kHz mono frames (Float32Array(320) ~= 20 ms) posted to main thread
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.acc = 0;
    this._buf = [];
  }
  process(inputs) {
    const ch0 = inputs[0][0];
    if (!ch0) return true;

    // downsample by nearest-neighbor (speech-friendly, simple)
    for (let i = 0; i < ch0.length; i++) {
      this.acc += 1;
      while (this.acc >= this.step) {
        this._buf.push(ch0[i]);
        this.acc -= this.step;
      }
    }
    // emit 20 ms frames
    while (this._buf.length >= 320) {
      const frame = new Float32Array(this._buf.slice(0, 320));
      this._buf = this._buf.slice(320);
      this.port.postMessage({ type: 'pcm16k', data: frame }, [frame.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);

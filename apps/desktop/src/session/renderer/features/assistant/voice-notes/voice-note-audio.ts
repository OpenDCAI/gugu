// #7199 一段录音(webm / m4a,谁录的都行)→ 交给听录音的模型的 16k 单声道 WAV(base64)。
// 解码与重采样交给浏览器(OfflineAudioContext 解出来就是它的采样率),这里只做混成单声道 + 写 WAV 头。

const TARGET_RATE = 16_000;

export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, TARGET_RATE, TARGET_RATE);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / decoded.numberOfChannels;
  }
  return mono;
}

export function encodeWav(samples: Float32Array, sampleRate = TARGET_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function segmentToWavBase64(blob: Blob): Promise<string> {
  return bytesToBase64(encodeWav(await decodeToMono16k(blob)));
}

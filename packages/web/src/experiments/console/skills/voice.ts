/**
 * Dictation (HK47 fork, PERS-23): a recording from the composer's mic goes to
 * the ear's Whisper on the 3090 and comes back as text for the composer.
 *   - transcribe: POST /api/hk47/transcribe, multipart `audio`. An empty string
 *     means the ear heard only silence.
 */
import { requestJson } from '../lib/http';

export async function transcribe(audio: Blob): Promise<string> {
  const form = new FormData();
  form.append('audio', audio, 'dictation.webm');
  const res = await requestJson<{ text: string }>('/api/hk47/transcribe', {
    method: 'POST',
    body: form,
  });
  return res.text;
}

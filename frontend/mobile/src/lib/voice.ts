/**
 * Giọng nói (CLAUDE.md mục 6): ưu tiên trên thiết bị, dự phòng server.
 * - STT: expo-speech-recognition (nhận dạng của hệ điều hành, cần development build) → không có thì ghi âm
 *   bằng expo-audio rồi gửi lên server (OpenAI STT) — phần ghi âm nằm ở màn hình chat (hook useAudioRecorder).
 * - TTS: expo-speech với giọng tiếng Việt của máy → không có thì OpenAI TTS qua server.
 */
import { Platform } from 'react-native'
import * as Speech from 'expo-speech'
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import { File, Paths } from 'expo-file-system'
import { voiceApi } from './api'

// ------------------------------------------------------------------ nhận dạng trên thiết bị

type RecognitionModule = typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule

let recognition: RecognitionModule | null | undefined

/** Module nhận dạng của hệ điều hành, hoặc null nếu không có (Expo Go, máy không hỗ trợ). */
export function deviceRecognition(): RecognitionModule | null {
  if (recognition !== undefined) return recognition
  try {
    // require lười: trong Expo Go không có native module → import thẳng sẽ làm hỏng app
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-speech-recognition') as typeof import('expo-speech-recognition')
    recognition = mod.ExpoSpeechRecognitionModule.isRecognitionAvailable() ? mod.ExpoSpeechRecognitionModule : null
  } catch {
    recognition = null
  }
  return recognition
}

export interface ListenHandle {
  stop(): void
}

/** Nghe một câu bằng nhận dạng của máy. Trả null nếu không dùng được (→ dùng ghi âm + server). */
export async function listenOnDevice(cb: {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
}): Promise<ListenHandle | null> {
  const mod = deviceRecognition()
  if (!mod) return null
  const perm = await mod.requestPermissionsAsync()
  if (!perm.granted) {
    cb.onError('Chưa cấp quyền micro / nhận dạng giọng nói.')
    return { stop() {} }
  }
  let text = ''
  let done = false
  const subs = [
    mod.addListener('result', (e) => {
      text = e.results[0]?.transcript ?? text
      cb.onPartial(text)
    }),
    mod.addListener('error', (e) => {
      if (e.error === 'language-not-supported') recognition = null // lần sau dùng server
      if (e.error !== 'no-speech' && e.error !== 'aborted') cb.onError(`Lỗi nhận dạng: ${e.message || e.error}`)
    }),
    mod.addListener('end', () => {
      subs.forEach((s) => s.remove())
      if (!done) {
        done = true
        cb.onFinal(text)
      }
    }),
  ]
  mod.start({ lang: 'vi-VN', interimResults: true, continuous: false })
  return { stop: () => mod.stop() }
}

// ------------------------------------------------------------------ đọc thành tiếng

let player: AudioPlayer | null = null
let webAudio: { pause(): void } | null = null
let viVoice: string | null | undefined

async function vietnameseVoice(): Promise<string | null> {
  if (viVoice !== undefined) return viVoice
  try {
    const voices = await Speech.getAvailableVoicesAsync()
    viVoice = voices.find((v) => v.language?.toLowerCase().startsWith('vi'))?.identifier ?? null
  } catch {
    viVoice = null
  }
  return viVoice
}

export function stopSpeaking() {
  void Speech.stop()
  if (player) {
    player.remove()
    player = null
  }
  webAudio?.pause()
  webAudio = null
}

/** Đọc `text`; gọi `onDone` khi xong / lỗi / bị dừng. */
export async function speak(text: string, onDone: () => void) {
  stopSpeaking()
  const plain = text.replace(/[*_`#]/g, '').trim()
  if (!plain) return onDone()
  const voice = await vietnameseVoice()
  if (voice) {
    Speech.speak(plain, { language: 'vi-VN', voice, onDone, onStopped: onDone, onError: () => onDone() })
    return
  }
  try {
    const bytes = await voiceApi.tts(plain.slice(0, 4000))
    if (Platform.OS === 'web') {
      const AudioCtor = (globalThis as unknown as { Audio: new (src: string) => HTMLAudioLike }).Audio
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
      const a = new AudioCtor(url)
      webAudio = a
      a.onended = () => {
        URL.revokeObjectURL(url)
        onDone()
      }
      await a.play()
      return
    }
    const file = new File(Paths.cache, `tts-${Date.now()}.mp3`)
    await file.write(new Uint8Array(bytes))
    const p = createAudioPlayer({ uri: file.uri })
    player = p
    p.addListener('playbackStatusUpdate', (s) => {
      if (s.didJustFinish) {
        p.remove()
        if (player === p) player = null
        try {
          file.delete()
        } catch {
          /* bỏ qua */
        }
        onDone()
      }
    })
    p.play()
  } catch {
    onDone()
  }
}

interface HTMLAudioLike {
  onended: (() => void) | null
  play(): Promise<void>
  pause(): void
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { useNavigation } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio'
import type { ChartBlock } from '../../../../shared/types'
import { fmtDateTime } from '../../../../shared/labels'
import { chatApi, errorText, readSse, voiceApi, type ChatThread, type StoredMessage } from '../../lib/api'
import { useUser } from '../../lib/auth'
import { useAutoRead } from '../../lib/settings'
import { useColors, type Colors } from '../../lib/theme'
import { listenOnDevice, speak, stopSpeaking, type ListenHandle } from '../../lib/voice'
import { ChartBlockView } from '../../components/Charts'
import { Badge, Button, Muted } from '../../components/ui'

// ------------------------------------------------------------------ kiểu

interface Proposal {
  id: string
  kind: string
  description: string
  note?: string | null
  delay_s?: number | null
}
interface Outcome {
  id: string
  description: string
  status: string
  text?: string
}
type Part =
  | { kind: 'text'; text: string }
  | { kind: 'chart'; block: ChartBlock }
  | { kind: 'proposal'; proposals: Proposal[]; note: string | null; status: 'pending' | 'approved' | 'rejected' | 'closed' }
  | { kind: 'result'; expired: boolean; outcomes: Outcome[] }
  | { kind: 'error'; text: string }
interface Msg {
  id: number
  role: 'user' | 'assistant'
  parts: Part[]
  voice?: boolean
  streaming?: boolean
  status?: string
  speech?: string
}

const SUGGESTIONS = [
  'Tình hình kho thế nào?',
  'Cho xem nhiệt độ hôm nay',
  'Đêm qua có ai vào kho không?',
  'Sao quạt đang bật?',
  'Bật đèn 10 phút',
  'Có cháy thì phải làm gì?',
]
const KIND_TITLE: Record<string, string> = {
  device: 'Điều khiển thiết bị',
  config: 'Đổi ngưỡng ESP32',
  memory: 'Ghi nhớ kiến thức chung về kho',
  alert: 'Phát thông báo',
}
const OUTCOME_LABEL: Record<string, string> = {
  success: 'Đã thực hiện',
  scheduled: 'Đã hẹn giờ',
  cancelled: 'Đã hủy lịch',
  rejected: 'Không thực hiện',
  blocked_by_policy: 'Bị lớp an toàn chặn',
  error: 'Lỗi',
}
/** Ghi chú của server: lệnh nào chạy cùng lúc / hẹn giờ. */
const noteOf = (src: Record<string, unknown>) => (typeof src.schedule_note === 'string' ? src.schedule_note : null)

let seq = 1

function blocksToParts(blocks: Record<string, unknown>[] | null | undefined, fallback: string): Part[] {
  if (!blocks?.length) return fallback.trim() ? [{ kind: 'text', text: fallback }] : []
  const out: Part[] = []
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text })
    else if (b.type === 'chart') out.push({ kind: 'chart', block: b as unknown as ChartBlock })
  }
  return out
}

function fromStored(list: StoredMessage[], pending: Record<string, unknown> | null): Msg[] {
  const lastConfirm = [...list].reverse().find((m) => m.kind === 'confirmation')?.id
  return list.map((m): Msg => {
    if (m.role === 'user') return { id: seq++, role: 'user', parts: [{ kind: 'text', text: m.content }], voice: m.input_mode === 'voice' }
    if (m.kind === 'error') return { id: seq++, role: 'assistant', parts: [{ kind: 'error', text: m.content }] }
    if (m.kind === 'confirmation') {
      const open = pending && m.id === lastConfirm
      const src = (open ? pending : (m.blocks?.[0] ?? {})) as Record<string, unknown>
      return {
        id: seq++,
        role: 'assistant',
        parts: [{ kind: 'proposal', proposals: (src.proposals as Proposal[]) ?? [], note: noteOf(src), status: open ? 'pending' : 'closed' }],
      }
    }
    return { id: seq++, role: 'assistant', parts: blocksToParts(m.blocks, m.content) }
  })
}

const plain = (m: Msg) => m.speech ?? m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n')

// ------------------------------------------------------------------ markdown tối giản

function inline(text: string, c: Colors): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    out.push(
      tok.startsWith('**') ? (
        <Text key={k++} style={{ fontWeight: '800' }}>
          {tok.slice(2, -2)}
        </Text>
      ) : (
        <Text key={k++} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', backgroundColor: c.surface3 }}>
          {tok.slice(1, -1)}
        </Text>
      ),
    )
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Markdown({ text, color }: { text: string; color: string }) {
  const c = useColors()
  return (
    <View style={{ gap: 2 }}>
      {text
        .trimEnd()
        .split('\n')
        .map((l, i) => {
          const bullet = /^\s*[-*] /.test(l)
          const heading = /^#{1,4} /.test(l)
          const body = l.replace(/^\s*[-*] /, '').replace(/^#+ /, '')
          return (
            <Text key={i} style={{ color, fontSize: 15, lineHeight: 21, paddingLeft: bullet ? 10 : 0, fontWeight: heading ? '800' : '400' }}>
              {bullet ? '• ' : ''}
              {inline(body, c)}
            </Text>
          )
        })}
    </View>
  )
}

// ------------------------------------------------------------------ màn hình

export default function Chat() {
  const c = useColors()
  const user = useUser()
  const nav = useNavigation()
  const [autoRead] = useAutoRead()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [mic, setMic] = useState<'idle' | 'device' | 'record' | 'stt'>('idle')
  const [speaking, setSpeaking] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [threads, setThreads] = useState<ChatThread[] | null>(null)
  const threadRef = useRef<string | null>(null)
  const listRef = useRef<FlatList<Msg>>(null)
  const listenRef = useRef<ListenHandle | null>(null)
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)

  useEffect(() => () => stopSpeaking(), [])

  const flash = (t: string) => {
    setNotice(t)
    setTimeout(() => setNotice((n) => (n === t ? '' : n)), 6000)
  }
  const update = (id: number, fn: (m: Msg) => Msg) => setMsgs((prev) => prev.map((m) => (m.id === id ? fn(m) : m)))

  const consume = async (id: number, res: Response, autoSpeak: boolean) => {
    let draft = ''
    let speech: string | null = null
    const withDraft = (m: Msg): Msg => {
      const keep = m.parts.filter((p) => p.kind !== 'text')
      return { ...m, parts: draft ? [...keep, { kind: 'text', text: draft }] : keep }
    }
    for await (const { event, data } of readSse(res)) {
      const d = (data ?? {}) as Record<string, unknown>
      if (event === 'meta' && typeof d.thread_id === 'string') threadRef.current = d.thread_id
      else if (event === 'status') update(id, (m) => ({ ...m, status: String(d.text ?? '') }))
      else if (event === 'token') {
        draft += String(d.text ?? '')
        update(id, withDraft)
      } else if (event === 'discard') {
        draft = ''
        update(id, withDraft)
      } else if (event === 'confirmation') {
        draft = ''
        update(id, (m) => ({
          ...withDraft(m),
          status: undefined,
          parts: [...withDraft(m).parts, { kind: 'proposal', proposals: (d.proposals as Proposal[]) ?? [], note: noteOf(d), status: 'pending' }],
        }))
      } else if (event === 'result') {
        update(id, (m) => ({ ...m, parts: [...m.parts, { kind: 'result', expired: !!d.expired, outcomes: (d.outcomes as Outcome[]) ?? [] }] }))
      } else if (event === 'done') {
        const parts = blocksToParts(d.blocks as Record<string, unknown>[], String(d.message ?? draft))
        speech = typeof d.speech === 'string' ? d.speech : parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n')
        const sp = speech
        update(id, (m) => ({ ...m, status: undefined, speech: sp, parts: [...m.parts.filter((p) => p.kind === 'result'), ...parts] }))
      } else if (event === 'error') {
        update(id, (m) => ({ ...m, status: undefined, parts: [...m.parts, { kind: 'error', text: String(d.message ?? 'Lỗi') }] }))
      }
    }
    update(id, (m) => ({ ...m, streaming: false, status: undefined }))
    if (autoSpeak && speech) {
      setSpeaking(id)
      void speak(speech, () => setSpeaking((s) => (s === id ? null : s)))
    }
  }

  const runStream = async (start: () => Promise<Response>, autoSpeak: boolean) => {
    const id = seq++
    setMsgs((prev) => [...prev, { id, role: 'assistant', parts: [], streaming: true }])
    setBusy(true)
    try {
      await consume(id, await start(), autoSpeak)
    } catch (e) {
      update(id, (m) => ({ ...m, streaming: false, status: undefined, parts: [...m.parts, { kind: 'error', text: errorText(e) }] }))
    } finally {
      setBusy(false)
    }
  }

  const send = async (text: string, voice = false) => {
    const t = text.trim()
    if (!t || busy) return
    setInput('')
    stopSpeaking()
    setSpeaking(null)
    setMsgs((prev) => [...prev, { id: seq++, role: 'user', parts: [{ kind: 'text', text: t.slice(0, 2000) }], voice }])
    await runStream(() => chatApi.send(t.slice(0, 2000), threadRef.current, voice ? 'voice' : 'text'), voice && autoRead)
  }

  const decide = async (msgId: number, approved: boolean) => {
    const tid = threadRef.current
    if (!tid || busy) return
    update(msgId, (m) => ({
      ...m,
      parts: m.parts.map((p) => (p.kind === 'proposal' && p.status === 'pending' ? { ...p, status: approved ? 'approved' : 'rejected' } : p)),
    }))
    setMsgs((prev) => [...prev, { id: seq++, role: 'user', parts: [{ kind: 'text', text: approved ? 'Đồng ý' : 'Hủy' }] }])
    await runStream(() => chatApi.confirm(tid, approved), false)
  }

  const newThread = useCallback(() => {
    if (busy) return
    stopSpeaking()
    threadRef.current = null
    setMsgs([])
  }, [busy])

  const openThreads = async () => {
    setThreads([])
    try {
      setThreads(await chatApi.threads())
    } catch (e) {
      setThreads(null)
      flash(errorText(e))
    }
  }

  const openThread = async (id: string) => {
    setThreads(null)
    try {
      const t = await chatApi.thread(id)
      threadRef.current = id
      setMsgs(fromStored(t.messages, t.pending))
    } catch (e) {
      flash(errorText(e))
    }
  }

  // --- micro: nhận dạng của máy → không có thì ghi âm + server STT
  const toggleMic = async () => {
    if (mic === 'device') return listenRef.current?.stop()
    if (mic === 'record') {
      setMic('stt')
      try {
        await recorder.stop()
        const uri = recorder.uri
        if (!uri) throw new Error('Không có bản ghi âm')
        const text = await voiceApi.stt(uri)
        if (text.trim()) void send(text, true)
        else flash('Không nghe rõ, thử lại nhé.')
      } catch (e) {
        flash(errorText(e))
      } finally {
        setMic('idle')
      }
      return
    }
    if (mic !== 'idle') return
    stopSpeaking()
    const h = await listenOnDevice({
      onPartial: setInput,
      onFinal: (t) => {
        listenRef.current = null
        setMic('idle')
        if (t.trim()) void send(t, true) // gửi thẳng, không bước duyệt
      },
      onError: flash,
    })
    if (h) {
      listenRef.current = h
      setMic('device')
      return
    }
    // dự phòng: ghi âm rồi gửi lên server
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync()
      if (!perm.granted) return flash('Chưa cấp quyền micro.')
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record()
      setMic('record')
      flash('Đang ghi âm — bấm micro lần nữa để gửi.')
    } catch (e) {
      flash(`Không ghi âm được: ${errorText(e)}`)
    }
  }

  const toggleSpeak = (m: Msg) => {
    if (speaking === m.id) {
      stopSpeaking()
      setSpeaking(null)
      return
    }
    setSpeaking(m.id)
    void speak(plain(m), () => setSpeaking((s) => (s === m.id ? null : s)))
  }

  const pendingOpen = msgs.some((m) => m.parts.some((p) => p.kind === 'proposal' && p.status === 'pending'))

  useEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', gap: 16, marginRight: 14 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Lịch sử hội thoại" onPress={() => void openThreads()}>
            <Ionicons name="time-outline" size={22} color={c.text} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Cuộc trò chuyện mới" onPress={newThread}>
            <Ionicons name="add-circle-outline" size={22} color={c.text} />
          </Pressable>
        </View>
      ),
    })
  }, [nav, c, newThread]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        ref={listRef}
        data={msgs}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={{ padding: 12, gap: 10, flexGrow: 1 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 30 }}>
            <Ionicons name="chatbubble-ellipses-outline" size={40} color={c.accent} />
            <Text style={{ color: c.text, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
              Xin chào {user.fullName || user.username}, tôi có thể giúp gì?
            </Text>
            <Muted style={{ textAlign: 'center' }}>
              Hỏi trạng thái, lịch sử, biểu đồ, hoặc điều khiển thiết bị (luôn cần bạn bấm xác nhận). Bấm 🎤 để nói.
            </Muted>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {SUGGESTIONS.map((s) => (
                <Pressable
                  accessibilityRole="button"
                  key={s}
                  onPress={() => void send(s)}
                  style={{ borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: c.surface }}
                >
                  <Text style={{ color: c.text2, fontSize: 13 }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
        renderItem={({ item: m }) => (
          <View style={{ alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 6 }}>
            {m.streaming && !m.parts.some((p) => p.kind === 'text') && (
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', padding: 10, backgroundColor: c.surface, borderRadius: 14 }}>
                <ActivityIndicator size="small" color={c.accent} />
                <Muted>{m.status || 'Đang trả lời…'}</Muted>
              </View>
            )}
            {m.parts.map((p, i) => (
              <PartView key={i} part={p} msg={m} c={c} busy={busy} onDecide={(ok) => void decide(m.id, ok)} username={user.username} />
            ))}
            {m.role === 'assistant' && !m.streaming && m.parts.some((p) => p.kind === 'text') && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={speaking === m.id ? 'Dừng đọc' : 'Nghe'}
                onPress={() => toggleSpeak(m)}
                style={{ padding: 4 }}
              >
                <Ionicons name={speaking === m.id ? 'stop-circle-outline' : 'volume-medium-outline'} size={20} color={c.text3} />
              </Pressable>
            )}
          </View>
        )}
      />
      {notice ? <Text style={{ backgroundColor: c.warnSoft, color: c.warn, padding: 8, fontSize: 12.5 }}>{notice}</Text> : null}
      <View
        style={{ flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface, alignItems: 'flex-end' }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Micro"
          onPress={() => void toggleMic()}
          disabled={busy || pendingOpen || mic === 'stt'}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: mic === 'device' || mic === 'record' ? c.crit : c.surface3,
            opacity: busy || pendingOpen ? 0.5 : 1,
          }}
        >
          {mic === 'stt' ? (
            <ActivityIndicator color={c.accent} />
          ) : (
            <Ionicons name={mic === 'idle' ? 'mic-outline' : 'stop'} size={22} color={mic === 'idle' ? c.text : '#fff'} />
          )}
        </Pressable>
        <TextInput
          value={input}
          onChangeText={setInput}
          editable={!pendingOpen}
          multiline
          maxLength={2000}
          placeholder={
            pendingOpen
              ? 'Bấm Đồng ý hoặc Hủy ở trên trước'
              : mic === 'device'
                ? 'Đang nghe…'
                : mic === 'record'
                  ? 'Đang ghi âm…'
                  : 'Nhập câu hỏi, vd. “bật quạt 30 phút”'
          }
          placeholderTextColor={c.text3}
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 120,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: c.border,
            paddingHorizontal: 12,
            paddingVertical: 10,
            color: c.text,
            backgroundColor: c.surface2,
            fontSize: 15,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Gửi"
          onPress={() => void send(input)}
          disabled={busy || !input.trim() || pendingOpen}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.accent,
            opacity: busy || !input.trim() || pendingOpen ? 0.45 : 1,
          }}
        >
          <Ionicons name="send" size={18} color={c.onAccent} />
        </Pressable>
      </View>

      <Modal visible={threads !== null} animationType="slide" transparent onRequestClose={() => setThreads(null)}>
        <View style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, maxHeight: '75%', gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: c.text, fontSize: 17, fontWeight: '800', flex: 1 }}>Hội thoại</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Đóng" onPress={() => setThreads(null)}>
                <Ionicons name="close" size={24} color={c.text} />
              </Pressable>
            </View>
            <FlatList
              data={threads ?? []}
              keyExtractor={(t) => t.id}
              ListEmptyComponent={<Muted>Chưa có hội thoại.</Muted>}
              renderItem={({ item: t }) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 10 }}>
                  <Pressable accessibilityRole="button" style={{ flex: 1 }} onPress={() => void openThread(t.id)}>
                    <Text style={{ color: c.text, fontSize: 14.5 }} numberOfLines={1}>
                      {t.title || 'Hội thoại'}
                    </Text>
                    <Muted>{fmtDateTime(t.updated_at)}</Muted>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Xóa hội thoại"
                    onPress={async () => {
                      await chatApi.deleteThread(t.id).catch(() => undefined)
                      if (threadRef.current === t.id) newThread()
                      setThreads((prev) => (prev ?? []).filter((x) => x.id !== t.id))
                    }}
                    style={{ padding: 8 }}
                  >
                    <Ionicons name="trash-outline" size={18} color={c.text3} />
                  </Pressable>
                </View>
              )}
            />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  )
}

function PartView({
  part: p,
  msg,
  c,
  busy,
  onDecide,
  username,
}: {
  part: Part
  msg: Msg
  c: Colors
  busy: boolean
  onDecide: (ok: boolean) => void
  username: string
}) {
  const user = msg.role === 'user'
  if (p.kind === 'text')
    return (
      <View
        style={{
          maxWidth: '88%',
          backgroundColor: user ? c.accent : c.surface,
          borderRadius: 16,
          paddingHorizontal: 12,
          paddingVertical: 9,
          borderWidth: user ? 0 : 1,
          borderColor: c.border,
        }}
      >
        {msg.voice && <Ionicons name="mic" size={12} color={user ? c.onAccent : c.text3} />}
        <Markdown text={p.text} color={user ? c.onAccent : c.text} />
      </View>
    )
  if (p.kind === 'chart')
    return (
      <View style={{ width: '100%', backgroundColor: c.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.border, gap: 8 }}>
        <Text style={{ color: c.text, fontWeight: '700' }}>{p.block.title}</Text>
        <ChartBlockView block={p.block} height={170} />
      </View>
    )
  if (p.kind === 'error')
    return (
      <View style={{ maxWidth: '88%', backgroundColor: c.critSoft, borderRadius: 14, padding: 10, flexDirection: 'row', gap: 6 }}>
        <Ionicons name="warning-outline" size={16} color={c.crit} />
        <Text style={{ color: c.crit, flex: 1 }}>{p.text}</Text>
      </View>
    )
  if (p.kind === 'result')
    return (
      <View style={{ maxWidth: '92%', backgroundColor: c.surface, borderRadius: 14, padding: 10, gap: 6, borderWidth: 1, borderColor: c.border }}>
        {p.outcomes.map((o) => (
          <View key={o.id} style={{ gap: 3 }}>
            <Badge tone={o.status === 'success' ? 'ok' : o.status === 'scheduled' ? 'info' : o.status === 'rejected' ? 'neutral' : 'crit'} label={OUTCOME_LABEL[o.status] ?? o.status} />
            <Text style={{ color: c.text2, fontSize: 13.5 }}>{o.text || o.description}</Text>
          </View>
        ))}
        {p.expired && <Muted>Đề xuất đã hết hạn — hãy yêu cầu lại.</Muted>}
      </View>
    )
  const kinds = [...new Set(p.proposals.map((x) => x.kind))]
  return (
    <View style={{ maxWidth: '92%', backgroundColor: c.accentSoft, borderRadius: 14, padding: 12, gap: 8, borderWidth: 1, borderColor: c.accent }}>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <Ionicons name="shield-checkmark-outline" size={18} color={c.accent} />
        <Text style={{ color: c.text, fontWeight: '800', flex: 1 }}>{kinds.map((k) => KIND_TITLE[k] ?? 'Hành động').join(' · ')} — cần bạn xác nhận</Text>
      </View>
      {p.proposals.map((x) => (
        <View key={x.id}>
          <Text style={{ color: c.text, fontSize: 14 }}>• {x.description}</Text>
          {x.note ? <Muted>Lưu ý: {x.note}</Muted> : null}
        </View>
      ))}
      {p.note ? (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Ionicons name="time-outline" size={14} color={c.text2} style={{ marginTop: 2 }} />
          <Muted style={{ flex: 1 }}>{p.note}</Muted>
        </View>
      ) : null}
      {p.status === 'pending' ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button style={{ flex: 1 }} kind="primary" label="Đồng ý" disabled={busy} onPress={() => onDecide(true)} />
          <Button style={{ flex: 1 }} label="Hủy" disabled={busy} onPress={() => onDecide(false)} />
        </View>
      ) : (
        <Badge
          tone={p.status === 'approved' ? 'ok' : 'neutral'}
          label={p.status === 'approved' ? `Đã đồng ý bởi ${username}` : p.status === 'rejected' ? 'Đã hủy' : 'Đã xử lý'}
        />
      )}
    </View>
  )
}

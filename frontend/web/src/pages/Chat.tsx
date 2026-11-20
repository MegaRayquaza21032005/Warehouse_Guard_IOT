import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Check, Loader2, Mic, MicOff, Plus, Send, ShieldCheck, Square, Trash2, TriangleAlert, User as UserIcon, Volume2, X } from 'lucide-react'
import type { ChartBlock } from '../types'
import { useAuth, useAutoRead } from '../lib/hooks'
import { chatApi, errorText, voiceApi, type ChatThread, type StoredMessage } from '../api'
import { readSse } from '../lib/sse'
import { fmtDateTime } from '../lib/labels'
import { ChartBlockView } from '../components/charts/Charts'

// ------------------------------------------------------------------ kiểu tin nhắn

interface Proposal {
  id: string
  tool: string
  kind: string
  description: string
  note?: string | null
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
  | { kind: 'proposal'; proposals: Proposal[]; expiresAt: number | null; status: 'pending' | 'approved' | 'rejected' | 'closed' }
  | { kind: 'result'; approved: boolean; expired: boolean; outcomes: Outcome[] }
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
  'Cho xem nhiệt độ tuần này',
  'Đêm qua có ai vào kho không?',
  'Sao quạt đang bật?',
  'Bật đèn 10 phút',
  'Đặt ngưỡng nóng 40',
  'Nhớ giúp tôi là chiều thứ 6 hay hàn kim loại',
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
  rejected: 'Không thực hiện',
  blocked_by_policy: 'Bị lớp an toàn chặn',
  error: 'Lỗi',
}

let seq = 1

// ------------------------------------------------------------------ chuyển đổi dữ liệu server

function blocksToParts(blocks: Record<string, unknown>[] | null | undefined, fallback: string): Part[] {
  if (!blocks?.length) return fallback.trim() ? [{ kind: 'text', text: fallback }] : []
  const out: Part[] = []
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text })
    else if (b.type === 'chart') out.push({ kind: 'chart', block: b as unknown as ChartBlock })
  }
  return out
}

function proposalPart(p: Record<string, unknown>, status: 'pending' | 'closed'): Part {
  return {
    kind: 'proposal',
    proposals: (p.proposals as Proposal[]) ?? [],
    expiresAt: typeof p.expires_at === 'number' ? p.expires_at : null,
    status,
  }
}

function fromStored(list: StoredMessage[], pending: Record<string, unknown> | null): Msg[] {
  const lastConfirm = [...list].reverse().find((m) => m.kind === 'confirmation')?.id
  return list.map((m) => {
    if (m.role === 'user') return { id: seq++, role: 'user', parts: [{ kind: 'text', text: m.content }], voice: m.input_mode === 'voice' }
    if (m.kind === 'error') return { id: seq++, role: 'assistant', parts: [{ kind: 'error', text: m.content }] }
    if (m.kind === 'confirmation') {
      const b = (m.blocks?.[0] ?? {}) as Record<string, unknown>
      const open = pending && m.id === lastConfirm
      return { id: seq++, role: 'assistant', parts: [proposalPart(open ? pending : b, open ? 'pending' : 'closed')] }
    }
    return { id: seq++, role: 'assistant', parts: blocksToParts(m.blocks, m.content) }
  })
}

const plainText = (m: Msg) =>
  m.speech ??
  m.parts
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('\n')
    .replace(/[*_`#]/g, '')

// ------------------------------------------------------------------ giọng nói (ưu tiên trên thiết bị, dự phòng server)

interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

function getRecognition(): Recognition | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const C = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return C ? new C() : null
}

const viVoice = () => ('speechSynthesis' in window ? speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('vi')) : undefined)

let audioEl: HTMLAudioElement | null = null

function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel()
  if (audioEl) {
    audioEl.pause()
    audioEl = null
  }
}

/** Đọc thành tiếng: giọng tiếng Việt của thiết bị, không có → OpenAI TTS qua server. */
async function speak(text: string, onEnd: () => void) {
  stopSpeaking()
  if (!text.trim()) return onEnd()
  const vi = viVoice()
  if (vi) {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'vi-VN'
    u.voice = vi
    u.onend = onEnd
    u.onerror = onEnd
    speechSynthesis.speak(u)
    return
  }
  try {
    const blob = await voiceApi.tts(text.slice(0, 4000))
    const url = URL.createObjectURL(blob)
    const a = new Audio(url)
    audioEl = a
    a.onended = () => {
      URL.revokeObjectURL(url)
      onEnd()
    }
    await a.play()
  } catch {
    onEnd()
  }
}

// ------------------------------------------------------------------ markdown tối giản (**đậm**, _nghiêng_, `code`, danh sách)

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) out.push(<b key={k++}>{tok.slice(2, -2)}</b>)
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>)
    else out.push(<i key={k++}>{tok.slice(1, -1)}</i>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((l, i) => {
        const bullet = /^\s*[-*] /.test(l)
        const heading = /^#{1,4} /.test(l)
        return (
          <Fragment key={i}>
            {bullet ? (
              <span style={{ display: 'block', paddingLeft: 12 }}>• {inline(l.replace(/^\s*[-*] /, ''))}</span>
            ) : heading ? (
              <b style={{ display: 'block' }}>{inline(l.replace(/^#+ /, ''))}</b>
            ) : (
              inline(l)
            )}
            {i < lines.length - 1 && !bullet && !heading && '\n'}
          </Fragment>
        )
      })}
    </>
  )
}

// ------------------------------------------------------------------ trang

export default function Chat() {
  const { user } = useAuth()
  const [autoRead] = useAutoRead()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const recRef = useRef<Recognition | null>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const threadRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const loadThreads = useCallback(() => {
    chatApi
      .threads()
      .then(setThreads)
      .catch(() => setThreads([]))
  }, [])

  useEffect(() => {
    loadThreads()
    return () => {
      abortRef.current?.abort()
      stopSpeaking()
    }
  }, [loadThreads])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  const flash = (t: string, ms = 6000) => {
    setNotice(t)
    setTimeout(() => setNotice((n) => (n === t ? '' : n)), ms)
  }

  const update = (id: number, fn: (m: Msg) => Msg) => setMsgs((prev) => prev.map((m) => (m.id === id ? fn(m) : m)))

  /** Đọc một stream SSE vào tin nhắn trợ lý `id`. */
  const consume = async (id: number, res: Response, autoSpeak: boolean) => {
    let draft = ''
    const setDraft = (m: Msg): Msg => {
      const keep = m.parts.filter((p) => p.kind !== 'text')
      return { ...m, parts: draft ? [...keep, { kind: 'text', text: draft }] : keep }
    }
    let doneSpeech: string | null = null
    for await (const { event, data } of readSse(res)) {
      const d = (data ?? {}) as Record<string, unknown>
      switch (event) {
        case 'meta':
          if (typeof d.thread_id === 'string') {
            threadRef.current = d.thread_id
            setThreadId(d.thread_id)
          }
          break
        case 'status':
          update(id, (m) => ({ ...m, status: String(d.text ?? '') }))
          break
        case 'token':
          draft += String(d.text ?? '')
          update(id, setDraft)
          break
        case 'discard':
          draft = ''
          update(id, setDraft)
          break
        case 'confirmation':
          draft = ''
          update(id, (m) => ({ ...setDraft(m), parts: [...setDraft(m).parts, proposalPart(d, 'pending')], status: undefined }))
          break
        case 'result':
          update(id, (m) => ({
            ...m,
            parts: [...m.parts, { kind: 'result', approved: !!d.approved, expired: !!d.expired, outcomes: (d.outcomes as Outcome[]) ?? [] }],
          }))
          break
        case 'done': {
          const parts = blocksToParts(d.blocks as Record<string, unknown>[], String(d.message ?? draft))
          doneSpeech = typeof d.speech === 'string' ? d.speech : parts.map((x) => (x.kind === 'text' ? x.text : '')).join('\n')
          const speech = doneSpeech
          update(id, (m) => ({ ...m, parts: [...m.parts.filter((x) => x.kind === 'result'), ...parts], speech, status: undefined }))
          break
        }
        case 'error':
          update(id, (m) => ({ ...m, parts: [...m.parts, { kind: 'error', text: String(d.message ?? 'Lỗi') }], status: undefined }))
          break
      }
    }
    update(id, (m) => ({ ...m, streaming: false, status: undefined }))
    if (autoSpeak && doneSpeech) {
      setSpeaking(id)
      void speak(String(doneSpeech).replace(/[*_`#]/g, ''), () => setSpeaking((s) => (s === id ? null : s)))
    }
  }

  const runStream = async (start: (signal: AbortSignal) => Promise<Response>, autoSpeak: boolean) => {
    const id = seq++
    setMsgs((prev) => [...prev, { id, role: 'assistant', parts: [], streaming: true }])
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await consume(id, await start(ac.signal), autoSpeak)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') update(id, (m) => ({ ...m, parts: [...m.parts, { kind: 'error', text: errorText(e) }] }))
      update(id, (m) => ({ ...m, streaming: false, status: undefined }))
    } finally {
      setBusy(false)
      abortRef.current = null
      loadThreads()
    }
  }

  const send = async (text: string, voice = false) => {
    const t = text.trim()
    if (!t || busy) return
    if (t.length > 2000) return flash('Tin nhắn tối đa 2000 ký tự.')
    setInput('')
    stopSpeaking()
    setSpeaking(null)
    setMsgs((prev) => [...prev, { id: seq++, role: 'user', parts: [{ kind: 'text', text: t }], voice }])
    await runStream((signal) => chatApi.send(t, threadRef.current, voice ? 'voice' : 'text', signal), voice && autoRead)
  }

  const decide = async (msgId: number, approved: boolean) => {
    const tid = threadRef.current
    if (!tid || busy) return
    update(msgId, (m) => ({ ...m, parts: m.parts.map((p) => (p.kind === 'proposal' && p.status === 'pending' ? { ...p, status: approved ? 'approved' : 'rejected' } : p)) }))
    setMsgs((prev) => [...prev, { id: seq++, role: 'user', parts: [{ kind: 'text', text: approved ? 'Đồng ý' : 'Hủy' }] }])
    await runStream((signal) => chatApi.confirm(tid, approved, signal), false)
  }

  const openThread = async (id: string) => {
    if (busy) return
    stopSpeaking()
    try {
      const t = await chatApi.thread(id)
      threadRef.current = id
      setThreadId(id)
      setMsgs(fromStored(t.messages, t.pending))
    } catch (e) {
      flash(errorText(e))
    }
  }

  const newThread = () => {
    if (busy) return
    stopSpeaking()
    threadRef.current = null
    setThreadId(null)
    setMsgs([])
  }

  const removeThread = async (id: string) => {
    if (!confirm('Xóa hội thoại này?')) return
    try {
      await chatApi.deleteThread(id)
      if (threadRef.current === id) newThread()
      loadThreads()
    } catch (e) {
      flash(errorText(e))
    }
  }

  // --- micro: Web Speech API; trình duyệt không hỗ trợ → ghi âm rồi gửi lên server (OpenAI STT)
  const toggleMic = async () => {
    if (listening) {
      recRef.current?.stop()
      mediaRef.current?.stop()
      return
    }
    stopSpeaking()
    const rec = getRecognition()
    if (rec) {
      rec.lang = 'vi-VN'
      rec.interimResults = true
      rec.continuous = false
      let finalText = ''
      rec.onresult = (e) => {
        let txt = ''
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript
        finalText = txt
        setInput(txt)
      }
      rec.onerror = (e) => flash(e.error === 'not-allowed' ? 'Chưa cấp quyền micro cho trang.' : `Lỗi nhận dạng giọng nói: ${e.error}`)
      rec.onend = () => {
        setListening(false)
        recRef.current = null
        if (finalText.trim()) void send(finalText, true) // gửi thẳng, không bước duyệt
      }
      recRef.current = rec
      setListening(true)
      rec.start()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return flash('Trình duyệt không hỗ trợ ghi âm.')
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      const chunks: Blob[] = []
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setListening(false)
        mediaRef.current = null
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
        if (blob.size < 1000) return
        setTranscribing(true)
        try {
          const text = await voiceApi.stt(blob, `voice.${(mr.mimeType || 'audio/webm').includes('ogg') ? 'ogg' : 'webm'}`)
          if (text.trim()) void send(text, true)
          else flash('Không nghe rõ, thử lại nhé.')
        } catch (e) {
          flash(errorText(e))
        } finally {
          setTranscribing(false)
        }
      }
      mediaRef.current = mr
      mr.start()
      setListening(true)
      flash('Đang ghi âm — bấm micro lần nữa để gửi.', 4000)
    } catch {
      flash('Chưa cấp quyền micro cho trang.')
    }
  }

  const toggleSpeak = (m: Msg) => {
    if (speaking === m.id) {
      stopSpeaking()
      setSpeaking(null)
      return
    }
    setSpeaking(m.id)
    void speak(plainText(m), () => setSpeaking((s) => (s === m.id ? null : s)))
  }

  const pendingOpen = msgs.some((m) => m.parts.some((p) => p.kind === 'proposal' && p.status === 'pending'))

  return (
    <div className="chat">
      <div className="card chat-main">
        <div className="card-head" style={{ padding: '12px 16px', margin: 0, borderBottom: '1px solid var(--border)' }}>
          <Bot size={18} color="var(--accent)" />
          <div>
            <h3>Trợ lý kho</h3>
            <div className="sub">Hỏi bằng tiếng Việt · trả lời theo dữ liệu thật của kho</div>
          </div>
          <div className="actions">
            {speaking !== null && (
              <button
                className="btn sm"
                onClick={() => {
                  stopSpeaking()
                  setSpeaking(null)
                }}
              >
                <Square size={13} /> Dừng đọc
              </button>
            )}
            <button className="btn sm ghost" onClick={newThread} disabled={busy}>
              <Plus size={15} /> Cuộc trò chuyện mới
            </button>
          </div>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {msgs.length === 0 && (
            <div style={{ margin: 'auto', maxWidth: 560, textAlign: 'center', display: 'grid', gap: 14, justifyItems: 'center' }}>
              <div className="brand-logo" style={{ width: 48, height: 48, borderRadius: 14 }}>
                <Bot size={24} />
              </div>
              <h2 style={{ fontSize: 18 }}>Xin chào {user.fullName || user.username}, tôi có thể giúp gì?</h2>
              <p className="muted" style={{ margin: 0 }}>
                Hỏi trạng thái, lịch sử, biểu đồ, giải thích cảnh báo, hoặc điều khiển thiết bị (luôn cần bạn bấm xác nhận). Bấm 🎤 để nói.
              </p>
              <div className="suggest" style={{ justifyContent: 'center' }}>
                {SUGGESTIONS.slice(0, 6).map((s) => (
                  <button key={s} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="avatar">{m.role === 'user' ? <UserIcon size={15} /> : <Bot size={15} />}</div>
              <div className="stack">
                {m.streaming && !m.parts.some((p) => p.kind === 'text') && (
                  <div className="bubble typing" aria-label="Đang trả lời">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
                {m.status && (
                  <div className="faint" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Loader2 size={12} className="spin" /> {m.status}
                  </div>
                )}
                {m.parts.map((p, i) => (
                  <PartView key={i} part={p} voice={m.voice} busy={busy} onDecide={(ok) => void decide(m.id, ok)} username={user.username} />
                ))}
                {m.role === 'assistant' && !m.streaming && m.parts.some((p) => p.kind === 'text') && (
                  <div className="tools">
                    <button className="btn ghost sm icon" style={{ width: 26, height: 26 }} onClick={() => toggleSpeak(m)} title={speaking === m.id ? 'Dừng đọc' : 'Nghe'}>
                      {speaking === m.id ? <Square size={13} /> : <Volume2 size={14} />}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {notice && <div style={{ padding: '8px 14px', fontSize: 12.5, background: 'var(--warn-soft)', color: 'var(--warn)' }}>{notice}</div>}
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <button
            type="button"
            className={`btn icon mic ${listening ? 'listening' : ''}`}
            onClick={() => void toggleMic()}
            disabled={busy || transcribing || pendingOpen}
            title={listening ? 'Dừng nghe' : 'Bấm để nói'}
            aria-label="Micro"
          >
            {transcribing ? <Loader2 size={17} className="spin" /> : listening ? <MicOff size={17} /> : <Mic size={17} />}
          </button>
          <textarea
            rows={1}
            value={input}
            maxLength={2000}
            disabled={pendingOpen}
            placeholder={pendingOpen ? 'Hãy bấm Đồng ý hoặc Hủy đề xuất ở trên trước' : listening ? 'Đang nghe…' : transcribing ? 'Đang nhận dạng…' : 'Nhập câu hỏi, vd. “bật quạt 30 phút”'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
          />
          <button type="submit" className="btn primary icon" style={{ width: 40, height: 40, borderRadius: 12 }} disabled={busy || !input.trim() || pendingOpen} aria-label="Gửi">
            <Send size={17} />
          </button>
        </form>
      </div>

      <aside className="chat-side grid" style={{ alignContent: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h3>Hội thoại</h3>
          </div>
          {threads.length === 0 ? (
            <div className="faint" style={{ fontSize: 13 }}>
              Chưa có hội thoại.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 2, maxHeight: 260, overflowY: 'auto' }}>
              {threads.map((t) => (
                <div
                  key={t.id}
                  className={`nav-link ${t.id === threadId ? 'active' : ''}`}
                  style={{ cursor: 'pointer', padding: '6px 8px', fontSize: 13, gap: 6 }}
                  onClick={() => void openThread(t.id)}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || 'Hội thoại'}</div>
                    <div className="faint" style={{ fontSize: 11.5 }}>
                      {fmtDateTime(t.updated_at)}
                    </div>
                  </div>
                  <button
                    className="btn ghost sm icon"
                    style={{ width: 24, height: 24 }}
                    title="Xóa"
                    aria-label="Xóa hội thoại"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeThread(t.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Gợi ý</h3>
          </div>
          <div className="suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => void send(s)} disabled={busy || pendingOpen}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="card" style={{ fontSize: 13 }}>
          <div className="card-head">
            <h3>Quy tắc</h3>
          </div>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>
              Mọi lệnh điều khiển / đổi ngưỡng cần bấm <b>Đồng ý</b>.
            </li>
            <li>Không xác nhận bằng giọng nói.</li>
            <li>Lớp an toàn chặn lệnh nguy hiểm (vd. bật quạt khi nghi cháy).</li>
            <li>Không lưu file âm thanh — chỉ lưu chữ.</li>
          </ul>
        </div>
      </aside>
    </div>
  )
}

function PartView({ part: p, voice, busy, onDecide, username }: { part: Part; voice?: boolean; busy: boolean; onDecide: (ok: boolean) => void; username: string }) {
  if (p.kind === 'text')
    return (
      <div className="bubble">
        {voice && <Mic size={13} style={{ marginRight: 6, verticalAlign: -2, opacity: 0.8 }} />}
        <Markdown text={p.text.trimEnd()} />
      </div>
    )
  if (p.kind === 'chart')
    return (
      <div className="card" style={{ padding: 14, minWidth: 'min(560px, 72vw)' }}>
        <b style={{ fontSize: 13.5 }}>{p.block.title}</b>
        <div style={{ marginTop: 8 }}>
          <ChartBlockView block={p.block} height={190} />
        </div>
      </div>
    )
  if (p.kind === 'error')
    return (
      <div className="bubble" style={{ color: 'var(--crit)', display: 'flex', gap: 6 }}>
        <TriangleAlert size={15} style={{ flex: 'none', marginTop: 2 }} /> {p.text}
      </div>
    )
  if (p.kind === 'result')
    return (
      <div className="proposal">
        {p.outcomes.map((o) => (
          <div key={o.id} style={{ fontSize: 13 }}>
            <span className={`badge ${o.status === 'success' ? 'ok' : o.status === 'rejected' ? '' : 'crit'}`}>{OUTCOME_LABEL[o.status] ?? o.status}</span>{' '}
            {o.text || o.description}
          </div>
        ))}
        {p.expired && <span className="faint">Đề xuất đã hết hạn — hãy yêu cầu lại.</span>}
      </div>
    )
  // đề xuất cần xác nhận
  const kinds = [...new Set(p.proposals.map((x) => x.kind))]
  const expired = p.expiresAt !== null && Date.now() / 1000 > p.expiresAt
  return (
    <div className="proposal">
      <div className="ph">
        <ShieldCheck size={17} color="var(--accent)" /> {kinds.map((k) => KIND_TITLE[k] ?? 'Hành động').join(' · ')} — cần bạn xác nhận
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {p.proposals.map((x) => (
          <li key={x.id}>
            {x.description}
            {x.note && <div className="faint">Lưu ý: {x.note}</div>}
          </li>
        ))}
      </ul>
      {p.status === 'pending' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn primary sm" onClick={() => onDecide(true)} disabled={busy}>
            <Check size={14} /> Đồng ý
          </button>
          <button className="btn sm" onClick={() => onDecide(false)} disabled={busy}>
            <X size={14} /> Hủy
          </button>
          {expired && <span className="faint" style={{ fontSize: 12 }}>Có thể đã hết hạn</span>}
        </div>
      ) : (
        <span className={`badge ${p.status === 'approved' ? 'ok' : ''}`}>
          {p.status === 'approved' ? `Đã đồng ý bởi ${username}` : p.status === 'rejected' ? 'Đã hủy' : 'Đã xử lý'}
        </span>
      )}
    </div>
  )
}

/**
 * Parser `text/event-stream` thuần (không phụ thuộc trình duyệt / React Native) — web và mobile dùng chung.
 * Đẩy từng đoạn chữ nhận được vào `push()`, nhận lại các sự kiện đã đủ.
 */
export interface SseEvent {
  event: string
  data: unknown
}

export class SseParser {
  private buf = ''

  push(chunk: string): SseEvent[] {
    this.buf += chunk.replace(/\r\n/g, '\n')
    const out: SseEvent[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (!data.length) continue
      const text = data.join('\n')
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        /* giữ chuỗi */
      }
      out.push({ event, data: parsed })
    }
    return out
  }
}

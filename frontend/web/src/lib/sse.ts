import { SseParser, type SseEvent } from '../../../shared/sse'

/** Đọc stream `text/event-stream` từ `fetch` (EventSource không gửi được POST / header Authorization). */
export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  if (!res.body) return
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const parser = new SseParser()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield* parser.push(value)
  }
}

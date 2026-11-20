import { useCallback, useEffect, useState } from 'react'
import { Brain, RotateCcw, Save, Trash2, Warehouse } from 'lucide-react'
import type { DeviceConfig, MemoryItem } from '../types'
import { useAuth, useAutoRead, useLive, useTheme } from '../lib/hooks'
import { configApi, errorText, isAdmin, memoriesApi } from '../api'
import { DEFAULT_CONFIG, fmtWorkHours, validateConfig } from '../lib/config'
import { onLiveMessage } from '../lib/live'
import { fmtDateTime } from '../lib/labels'

const FIELDS: { group: string; items: { key: keyof DeviceConfig; label: string; unit: string; hint?: string }[] }[] = [
  {
    group: 'Khí / khói (MQ2)',
    items: [
      { key: 'mq2Warning', label: 'Ngưỡng cảnh báo', unit: 'ADC', hint: '0–4095' },
      { key: 'mq2Danger', label: 'Ngưỡng nguy hiểm', unit: 'ADC', hint: '> cảnh báo + 150' },
    ],
  },
  {
    group: 'Nhiệt độ & độ ẩm',
    items: [
      { key: 'tempHigh', label: 'Ngưỡng nóng', unit: '°C' },
      { key: 'humHigh', label: 'Ngưỡng độ ẩm cao', unit: '%' },
      { key: 'tempRiseC', label: 'Nhiệt độ tăng nhanh', unit: '°C', hint: 'Dùng để nhận biết cháy' },
      { key: 'tempRiseWindowMin', label: 'Trong khoảng', unit: 'phút', hint: '1–15' },
    ],
  },
  {
    group: 'Phun sương',
    items: [
      { key: 'mistFireMaxMin', label: 'Tối đa khi nghi cháy', unit: 'phút', hint: '1–60' },
      { key: 'mistCoolMaxMin', label: 'Tối đa mỗi lần làm mát', unit: 'phút', hint: '1–60' },
      { key: 'mistCooldownMin', label: 'Nghỉ giữa các lần', unit: 'phút', hint: '0–240' },
      { key: 'mistHumMax', label: 'Chỉ phun khi độ ẩm dưới', unit: '%', hint: '< ngưỡng độ ẩm cao' },
    ],
  },
  {
    group: 'Thông gió',
    items: [
      { key: 'humFanCheckMin', label: 'Kiểm tra hiệu quả sau', unit: 'phút', hint: '5–240' },
      { key: 'humFanMinDrop', label: 'Độ ẩm phải giảm ít nhất', unit: '%' },
    ],
  },
]

export default function Settings() {
  const snap = useLive()
  const { user } = useAuth()
  const [theme, setTheme] = useTheme()
  const [autoRead, setAutoRead] = useAutoRead()
  const saved = snap.config
  const [form, setForm] = useState<DeviceConfig>(saved)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null)

  useEffect(() => setForm(saved), [saved])

  const dirty = (Object.keys(form) as (keyof DeviceConfig)[]).filter((k) => form[k] !== saved[k])
  const localErr = validateConfig(form)
  const online = snap.live.online?.data.status === 'online'

  const save = async () => {
    const partial = Object.fromEntries(dirty.map((k) => [k, form[k]])) as Partial<DeviceConfig>
    setStatus({ kind: 'busy', text: 'Đang gửi xuống ESP32…' })
    // ESP32 xác nhận bằng status/config (có "error" nếu từ chối) → chờ tối đa 10 giây
    let off = () => {}
    const confirmed = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 10_000)
      off = onLiveMessage((type, data) => {
        if (type !== 'status.config') return
        clearTimeout(timer)
        const err = (data as { error?: unknown }).error
        resolve(err ? String(err) : null)
      })
    })
    try {
      await configApi.update(partial)
    } catch (e) {
      off()
      setStatus({ kind: 'err', text: errorText(e) })
      return
    }
    const err = await confirmed
    off()
    setStatus(
      err === 'timeout'
        ? { kind: 'err', text: online ? 'Đã gửi nhưng ESP32 chưa xác nhận sau 10 giây.' : 'Đã gửi (retained) — ESP32 đang mất kết nối, sẽ nhận khi kết nối lại.' }
        : err
          ? { kind: 'err', text: `ESP32 từ chối: ${err}` }
          : { kind: 'ok', text: 'ESP32 đã xác nhận và lưu cấu hình.' },
    )
  }

  return (
    <>
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div>
            <h2>Ngưỡng & thông số ESP32</h2>
            <div className="sub">
              Gửi qua `cmd/config`; ESP32 kiểm tra hợp lệ rồi lưu flash ·{' '}
              {snap.configUpdatedAt ? `ESP32 xác nhận ${fmtDateTime(snap.configUpdatedAt)}` : 'chưa nhận cấu hình từ ESP32 (đang hiện giá trị đã lưu / mặc định)'}
            </div>
          </div>
          <div className="actions">
            <button className="btn sm ghost" onClick={() => setForm({ ...DEFAULT_CONFIG })}>
              <RotateCcw size={14} /> Mặc định
            </button>
            <button className="btn sm primary" disabled={!dirty.length || !!localErr || status?.kind === 'busy'} onClick={() => void save()}>
              <Save size={14} /> Lưu {dirty.length ? `(${dirty.length})` : ''}
            </button>
          </div>
        </div>
        <div className="grid" style={{ gap: 20 }}>
          {FIELDS.map((g) => (
            <div key={g.group}>
              <h4 style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>{g.group}</h4>
              <div className="form-grid">
                {g.items.map((f) => (
                  <div className="field" key={f.key}>
                    <label htmlFor={f.key}>
                      {f.label} {form[f.key] !== saved[f.key] && <span className="badge accent">đã sửa</span>}
                    </label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        id={f.key}
                        className="input num"
                        type="number"
                        style={{ flex: 1 }}
                        value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                      />
                      <span className="faint" style={{ width: 36 }}>
                        {f.unit}
                      </span>
                    </div>
                    {f.hint && <span className="hint">{f.hint}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, minHeight: 20, fontSize: 13 }}>
          {localErr ? (
            <span className="error">{localErr}</span>
          ) : status ? (
            <span style={{ color: status.kind === 'ok' ? 'var(--ok)' : status.kind === 'err' ? 'var(--crit)' : 'var(--text-2)' }}>{status.text}</span>
          ) : (
            <span className="faint">Đổi ngưỡng ảnh hưởng trực tiếp đến luật an toàn trên ESP32. Kiểm tra kỹ trước khi lưu.</span>
          )}
        </div>
      </div>

      <div className="grid cols-2">
        <PersonalMemories />

        <div className="card">
          <div className="card-head">
            <h3>Tài khoản & giao diện</h3>
          </div>
          <div className="grid" style={{ gap: 14 }}>
            <Row label="Tài khoản">
              <b>{user.fullName || user.username}</b>{' '}
              <span className="faint">
                @{user.username} · {user.email}
                {isAdmin(user) && ' · quản trị'}
              </span>
            </Row>
            <Row label="Giao diện">
              <div className="seg">
                {(['system', 'light', 'dark'] as const).map((t) => (
                  <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
                    {t === 'system' ? 'Hệ thống' : t === 'light' ? 'Sáng' : 'Tối'}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Tự đọc câu trả lời khi nói bằng giọng">
              <button className={`switch ${autoRead ? 'on' : ''}`} onClick={() => setAutoRead(!autoRead)} aria-pressed={autoRead} />
            </Row>
            <Row label="Giờ làm việc (xác định đột nhập)">
              <span className="muted">{fmtWorkHours(snap.workHours)} (cấu hình ở backend)</span>
            </Row>
          </div>
        </div>
      </div>

      <WarehouseFacts />
    </>
  )
}

function useMemoryList(load: () => Promise<MemoryItem[]>) {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    try {
      setItems(await load())
      setError('')
    } catch (e) {
      setError(errorText(e))
      setItems([])
    }
  }, [load])
  useEffect(() => {
    void reload()
  }, [reload])
  return { items, setItems, error, setError }
}

function MemoryRow({ m, onDelete }: { m: MemoryItem; onDelete?: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{m.text}</div>
        <div className="faint" style={{ fontSize: 12 }}>
          {m.created_at ? fmtDateTime(m.created_at) : ''}
          {m.source && ` · ${m.source === 'chat' ? 'từ chat' : m.source}`}
        </div>
      </div>
      {onDelete && (
        <button className="btn ghost sm icon" style={{ width: 30 }} title="Xóa" aria-label="Xóa" onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      )}
    </div>
  )
}

function PersonalMemories() {
  const { items, setItems, error, setError } = useMemoryList(memoriesApi.mine)
  const remove = async (key: string) => {
    try {
      await memoriesApi.deleteMine(key)
      setItems((items ?? []).filter((x) => x.key !== key))
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <Brain size={18} color="var(--accent)" />
        <div>
          <h3>Trợ lý AI ghi nhớ về bạn</h3>
          <div className="sub">Chỉ bạn thấy · có thể xóa bất cứ lúc nào</div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {items === null ? (
        <div className="empty">Đang tải…</div>
      ) : items.length ? (
        items.map((m) => <MemoryRow key={m.key} m={m} onDelete={() => void remove(m.key)} />)
      ) : (
        !error && <div className="empty">Chưa có ghi nhớ nào. Bảo trợ lý “nhớ giúp tôi là …” để thêm.</div>
      )}
    </div>
  )
}

const loadFacts = () => memoriesApi.warehouse('facts')

function WarehouseFacts() {
  const { user } = useAuth()
  const { items, setItems, error, setError } = useMemoryList(loadFacts)
  const admin = isAdmin(user)
  const remove = async (key: string) => {
    try {
      await memoriesApi.deleteFact(key)
      setItems((items ?? []).filter((x) => x.key !== key))
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <Warehouse size={18} color="var(--accent)" />
        <div>
          <h3>Kiến thức chung về kho</h3>
          <div className="sub">Mọi người dùng đều thấy · trợ lý dùng để giải thích cảnh báo, không dùng để tắt cảnh báo nguy hiểm</div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {items === null ? (
        <div className="empty">Đang tải…</div>
      ) : items.length ? (
        items.map((m) => (
          <MemoryRow key={m.key} m={m} onDelete={admin || String(m.created_by) === String(user.id) ? () => void remove(m.key) : undefined} />
        ))
      ) : (
        !error && <div className="empty">Chưa có. Nói với trợ lý, vd. “nhớ giúp tôi là chiều thứ 6 kho hay hàn kim loại”.</div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  )
}

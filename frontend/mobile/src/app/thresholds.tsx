import { useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import type { DeviceConfig } from '../../../shared/types'
import { DEFAULT_CONFIG, validateConfig } from '../../../shared/config'
import { fmtDateTime } from '../../../shared/labels'
import { configApi, errorText } from '../lib/api'
import { useLive } from '../lib/hooks'
import { onLiveMessage } from '../lib/live'
import { useColors } from '../lib/theme'
import { Badge, Button, Card, CardTitle, ErrorText, Muted } from '../components/ui'

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
      { key: 'tempRiseC', label: 'Nhiệt độ tăng nhanh', unit: '°C' },
      { key: 'tempRiseWindowMin', label: 'Trong khoảng', unit: 'phút', hint: '1–15' },
    ],
  },
  {
    group: 'Phun sương',
    items: [
      { key: 'mistFireMaxMin', label: 'Tối đa khi nghi cháy', unit: 'phút', hint: '1–60' },
      { key: 'mistCoolMaxMin', label: 'Tối đa mỗi lần làm mát', unit: 'phút', hint: '1–60' },
      { key: 'mistCooldownMin', label: 'Nghỉ giữa các lần', unit: 'phút', hint: '0–240' },
      { key: 'mistHumMax', label: 'Chỉ phun khi độ ẩm dưới', unit: '%' },
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

/** Ngưỡng ESP32 — gửi `cmd/config` qua Java BE, ESP32 kiểm tra rồi xác nhận bằng `status/config`. */
export default function Thresholds() {
  const c = useColors()
  const snap = useLive()
  const saved = snap.config
  // chỉ giữ các ô người dùng đã sửa; ô chưa sửa luôn hiện giá trị ESP32 đang dùng
  const [edits, setEdits] = useState<Partial<Record<keyof DeviceConfig, string>>>({})
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null)
  const form = { ...toForm(saved), ...edits } as Record<keyof DeviceConfig, string>
  const setForm = (f: Record<keyof DeviceConfig, string>) =>
    setEdits(Object.fromEntries((Object.keys(f) as (keyof DeviceConfig)[]).filter((k) => f[k] !== String(saved[k])).map((k) => [k, f[k]])))

  const parsed = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v.replace(',', '.'))])) as unknown as DeviceConfig
  const invalid = Object.values(parsed).some((v) => !Number.isFinite(v))
  const dirty = (Object.keys(parsed) as (keyof DeviceConfig)[]).filter((k) => parsed[k] !== saved[k])
  const localErr = invalid ? 'Có ô chưa phải số' : validateConfig(parsed)

  const save = async () => {
    setStatus({ kind: 'busy', text: 'Đang gửi xuống ESP32…' })
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
      await configApi.update(Object.fromEntries(dirty.map((k) => [k, parsed[k]])))
    } catch (e) {
      off()
      return setStatus({ kind: 'err', text: errorText(e) })
    }
    const err = await confirmed
    off()
    if (!err) setEdits({})
    setStatus(
      err === 'timeout'
        ? { kind: 'err', text: 'Đã gửi nhưng ESP32 chưa xác nhận sau 10 giây.' }
        : err
          ? { kind: 'err', text: `ESP32 từ chối: ${err}` }
          : { kind: 'ok', text: 'ESP32 đã xác nhận và lưu cấu hình.' },
    )
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Muted>
        {snap.configUpdatedAt
          ? `ESP32 xác nhận lần cuối ${fmtDateTime(snap.configUpdatedAt)}`
          : 'Chưa nhận cấu hình từ ESP32 — đang hiện giá trị đã lưu / mặc định.'}
      </Muted>
      {FIELDS.map((g) => (
        <Card key={g.group}>
          <CardTitle title={g.group} />
          {g.items.map((f) => (
            <View key={f.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: 14 }}>{f.label}</Text>
                {f.hint ? <Muted>{f.hint}</Muted> : null}
              </View>
              {Number(form[f.key]) !== saved[f.key] && <Badge tone="accent" label="đã sửa" />}
              <TextInput
                value={form[f.key]}
                onChangeText={(v) => setForm({ ...form, [f.key]: v })}
                keyboardType="decimal-pad"
                accessibilityLabel={f.label}
                style={{
                  width: 76,
                  height: 40,
                  borderWidth: 1,
                  borderColor: c.border,
                  borderRadius: 8,
                  paddingHorizontal: 8,
                  color: c.text,
                  backgroundColor: c.surface2,
                  textAlign: 'right',
                }}
              />
              <Text style={{ color: c.text3, width: 36, fontSize: 12 }}>{f.unit}</Text>
            </View>
          ))}
        </Card>
      ))}
      {localErr ? (
        <ErrorText text={localErr} />
      ) : status ? (
        <Text style={{ color: status.kind === 'ok' ? c.ok : status.kind === 'err' ? c.crit : c.text2 }}>{status.text}</Text>
      ) : (
        <Muted>Đổi ngưỡng ảnh hưởng trực tiếp đến luật an toàn trên ESP32.</Muted>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button style={{ flex: 1 }} label="Mặc định" onPress={() => setForm(toForm(DEFAULT_CONFIG))} />
        <Button
          style={{ flex: 2 }}
          kind="primary"
          label={`Lưu${dirty.length ? ` (${dirty.length})` : ''}`}
          disabled={!dirty.length || !!localErr}
          busy={status?.kind === 'busy'}
          onPress={() => void save()}
        />
      </View>
    </ScrollView>
  )
}

function toForm(c: DeviceConfig): Record<keyof DeviceConfig, string> {
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])) as Record<keyof DeviceConfig, string>
}

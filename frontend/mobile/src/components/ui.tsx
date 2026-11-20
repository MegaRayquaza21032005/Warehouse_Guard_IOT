/** Thành phần giao diện cơ bản dùng chung giữa các màn hình. */
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { toneColors, useColors, type Tone } from '../lib/theme'

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors()
  return <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, style]}>{children}</View>
}

export function CardTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  const c = useColors()
  return (
    <View style={styles.cardHead}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.h3, { color: c.text }]}>{title}</Text>
        {sub ? <Text style={[styles.sub, { color: c.text3 }]}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  )
}

export function Badge({ label, tone = 'neutral', style }: { label: string; tone?: Tone; style?: StyleProp<ViewStyle> }) {
  const c = useColors()
  const t = toneColors(c, tone)
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }, style]}>
      <Text style={[styles.badgeText, { color: t.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

export function Button({
  label,
  onPress,
  kind = 'default',
  disabled,
  busy,
  icon,
  small,
  style,
}: {
  label: string
  onPress: () => void
  kind?: 'default' | 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  busy?: boolean
  icon?: ReactNode
  small?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const c = useColors()
  const bg = kind === 'primary' ? c.accent : kind === 'danger' ? c.crit : kind === 'ghost' ? 'transparent' : c.surface2
  const fg = kind === 'primary' || kind === 'danger' ? c.onAccent : c.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSm,
        { backgroundColor: bg, borderColor: kind === 'default' ? c.border : 'transparent', opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon}
      {label ? <Text style={[styles.btnText, small && { fontSize: 13 }, { color: fg }]}>{label}</Text> : null}
    </Pressable>
  )
}

/** Nhóm nút chọn một (giống `.seg` trên web). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[]
  value: T | null
  onChange: (v: T) => void
  disabled?: boolean
}) {
  const c = useColors()
  return (
    <View style={[styles.seg, { backgroundColor: c.surface3 }]}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={[styles.segItem, on && { backgroundColor: c.surface }, disabled && { opacity: 0.5 }]}
          >
            <Text style={{ color: on ? c.text : c.text2, fontWeight: on ? '700' : '500', fontSize: 13 }} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const c = useColors()
  return <Text style={[{ color: c.text3, fontSize: 12.5 }, style]}>{children}</Text>
}

export function Empty({ text }: { text: string }) {
  const c = useColors()
  return <Text style={{ color: c.text3, textAlign: 'center', paddingVertical: 24 }}>{text}</Text>
}

export function ErrorText({ text }: { text: string }) {
  const c = useColors()
  return <Text style={{ color: c.crit, fontSize: 13, marginVertical: 4 }}>{text}</Text>
}

export const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  h3: { fontSize: 15.5, fontWeight: '700' },
  sub: { fontSize: 12.5, marginTop: 2 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11.5, fontWeight: '700' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 14,
    minHeight: 42,
  },
  btnSm: { minHeight: 34, paddingHorizontal: 10 },
  btnText: { fontSize: 14.5, fontWeight: '600' },
  seg: { flexDirection: 'row', borderRadius: 10, padding: 3, gap: 2 },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 6 },
})

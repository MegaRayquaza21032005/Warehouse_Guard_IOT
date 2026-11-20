/** Bảng màu giống web (frontend/web/src/index.css), sáng / tối theo hệ thống. */
import { useColorScheme } from 'react-native'

const light = {
  bg: '#f3f5f8',
  surface: '#ffffff',
  surface2: '#f6f7f9',
  surface3: '#eceff3',
  border: '#e1e5ea',
  text: '#121821',
  text2: '#4f5b6b',
  text3: '#8892a0',
  accent: '#2557d6',
  accentSoft: '#e6edfd',
  onAccent: '#ffffff',
  ok: '#15803d',
  okSoft: '#e3f6e8',
  warn: '#b45309',
  warnSoft: '#fdf1d8',
  crit: '#c81e1e',
  critSoft: '#fde4e4',
  info: '#0e7490',
  infoSoft: '#dcf2f7',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  temp: '#eb6834',
  hum: '#2a78d6',
  mq2: '#6250d6',
  grid: '#e8ebef',
}

const dark: typeof light = {
  bg: '#0d1117',
  surface: '#151b23',
  surface2: '#1a212b',
  surface3: '#222a35',
  border: '#262f3b',
  text: '#e8edf3',
  text2: '#a8b3c1',
  text3: '#6e7a8a',
  accent: '#5b8cff',
  accentSoft: '#1b2843',
  onAccent: '#0b1220',
  ok: '#4ade80',
  okSoft: '#12291b',
  warn: '#fbbf24',
  warnSoft: '#2e2410',
  crit: '#f87171',
  critSoft: '#361516',
  info: '#38c4dc',
  infoSoft: '#0f2a31',
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'],
  temp: '#d95926',
  hum: '#3987e5',
  mq2: '#9085e9',
  grid: '#222a35',
}

export type Colors = typeof light

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light
}

export type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'accent' | 'neutral'

export function toneColors(c: Colors, tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'ok':
      return { fg: c.ok, bg: c.okSoft }
    case 'warn':
      return { fg: c.warn, bg: c.warnSoft }
    case 'crit':
      return { fg: c.crit, bg: c.critSoft }
    case 'info':
      return { fg: c.info, bg: c.infoSoft }
    case 'accent':
      return { fg: c.accent, bg: c.accentSoft }
    default:
      return { fg: c.text2, bg: c.surface3 }
  }
}

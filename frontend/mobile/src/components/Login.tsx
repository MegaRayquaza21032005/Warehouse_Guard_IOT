import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { auth, errorText, getApiUrl, setApiUrl } from '../lib/api'
import { useColors } from '../lib/theme'
import { Button, Card, ErrorText, Muted } from './ui'

export default function Login() {
  const c = useColors()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [server, setServer] = useState(getApiUrl())
  const [login, setLogin] = useState('')
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reg = mode === 'register'

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await setApiUrl(server)
      if (reg) await auth.register({ username: login.trim(), email: email.trim(), password, fullName: fullName.trim() || undefined })
      else await auth.login(login, password)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const input = {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 46,
    color: c.text,
    backgroundColor: c.surface2,
    fontSize: 15,
  } as const
  const label = { color: c.text2, fontSize: 13, fontWeight: '600' as const, marginBottom: 4 }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16, flexGrow: 1, justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: 'center', gap: 8 }}>
            <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="business" size={28} color={c.onAccent} />
            </View>
            <Text style={{ color: c.text, fontSize: 22, fontWeight: '800' }}>Giám sát kho</Text>
            <Muted style={{ textAlign: 'center' }}>Khói, khí độc, nhiệt độ, độ ẩm và an ninh kho theo thời gian thực</Muted>
          </View>
          <Card>
            <Text style={{ color: c.text, fontSize: 18, fontWeight: '700' }}>{reg ? 'Tạo tài khoản' : 'Đăng nhập'}</Text>
            <View>
              <Text style={label}>Địa chỉ máy chủ (Java BE)</Text>
              <TextInput
                style={input}
                value={server}
                onChangeText={setServer}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://192.168.1.13:8080"
                placeholderTextColor={c.text3}
              />
              <Muted style={{ marginTop: 4 }}>Điện thoại thật: dùng IP LAN của máy chạy backend, không dùng localhost.</Muted>
            </View>
            <View>
              <Text style={label}>{reg ? 'Tên đăng nhập' : 'Tên đăng nhập hoặc email'}</Text>
              <TextInput
                style={input}
                value={login}
                onChangeText={setLogin}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                accessibilityLabel="Tên đăng nhập"
              />
            </View>
            {reg && (
              <>
                <View>
                  <Text style={label}>Email</Text>
                  <TextInput
                    style={input}
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoComplete="email"
                    accessibilityLabel="Email"
                  />
                </View>
                <View>
                  <Text style={label}>Họ tên (tùy chọn)</Text>
                  <TextInput style={input} value={fullName} onChangeText={setFullName} accessibilityLabel="Họ tên" />
                </View>
              </>
            )}
            <View>
              <Text style={label}>Mật khẩu</Text>
              <TextInput
                style={input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete={reg ? 'new-password' : 'password'}
                onSubmitEditing={() => void submit()}
                accessibilityLabel="Mật khẩu"
              />
            </View>
            {error ? <ErrorText text={error} /> : null}
            <Button
              label={reg ? 'Tạo tài khoản' : 'Đăng nhập'}
              kind="primary"
              busy={busy}
              disabled={!login || !password || (reg && !email)}
              onPress={() => void submit()}
            />
            <Button
              label={reg ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký'}
              kind="ghost"
              onPress={() => {
                setMode(reg ? 'login' : 'register')
                setError('')
              }}
            />
          </Card>
          <Muted style={{ textAlign: 'center' }}>Cảm biến phổ thông (MQ135, DHT11) — không thay thế hệ thống báo cháy đạt chuẩn.</Muted>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

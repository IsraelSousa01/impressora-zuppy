/**
 * src/App.tsx
 * Main settings window UI.
 *
 * Sections:
 *  - Status header (connected / disconnected / not configured)
 *  - Printer selector + paper size toggle
 *  - "Imprimir Teste" button
 *  - Recent prints list (last 10)
 *  - Live queue depth indicator
 */

import React, { useEffect, useState, useCallback } from 'react'

// ─── Types (mirrored from electron/store.ts) ──────────────────────────────────

interface AppStatus {
  status: 'connected' | 'disconnected' | 'not_configured'
  version: string
  printer: string | null
  paper_size: '80mm' | '58mm'
  queue: number
  lastPrint: PrintLog | null
  tenant_name: string | null
  connected: boolean
}

interface PrintLog {
  id: string
  order_number: string
  status: 'printed' | 'failed' | 'pending'
  timestamp: string
  error?: string
}

interface AppConfig {
  tenant_id?: string
  tenant_name?: string
  printer_name?: string
  paper_size?: '80mm' | '58mm'
  auto_print?: boolean
}

// ─── Window API type ──────────────────────────────────────────────────────────

declare global {
  interface Window {
    zuppy: {
      getStatus: () => Promise<AppStatus>
      getConfig: () => Promise<AppConfig>
      getLogs: () => Promise<PrintLog[]>
      getPrinters: () => Promise<string[]>
      saveConfig: (patch: Partial<AppConfig>) => Promise<{ ok: boolean }>
      testPrint: (printerName?: string) => Promise<{ ok: boolean }>
      onUpdate: (cb: (event: string, data: unknown) => void) => () => void
    }
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AppStatus['status'] }) {
  const map = {
    connected: { color: '#22c55e', label: 'Conectado' },
    disconnected: { color: '#f97316', label: 'Desconectado' },
    not_configured: { color: '#ef4444', label: 'Não configurado' },
  }
  const { color, label } = map[status]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          backgroundColor: color,
          flexShrink: 0,
          boxShadow: `0 0 6px ${color}88`,
        }}
      />
      <span style={{ fontWeight: 600, color }}>{label}</span>
    </div>
  )
}

function LogRow({ log }: { log: PrintLog }) {
  const statusColor =
    log.status === 'printed'
      ? '#22c55e'
      : log.status === 'failed'
      ? '#ef4444'
      : '#94a3b8'

  const date = new Date(log.timestamp).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderBottom: '1px solid #1e293b',
        fontSize: 13,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: statusColor,
          flexShrink: 0,
        }}
      />
      <span style={{ color: '#94a3b8', flexShrink: 0 }}>{date}</span>
      <span style={{ fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        #{log.order_number}
      </span>
      <span style={{ color: statusColor, textTransform: 'capitalize', flexShrink: 0 }}>
        {log.status}
      </span>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [config, setConfig] = useState<AppConfig>({})
  const [logs, setLogs] = useState<PrintLog[]>([])
  const [printers, setPrinters] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [testPrinting, setTestPrinting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  // ── Data loading ──────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    try {
      const [s, c, l] = await Promise.all([
        window.zuppy.getStatus(),
        window.zuppy.getConfig(),
        window.zuppy.getLogs(),
      ])
      setStatus(s)
      setConfig(c)
      setLogs(l.slice(0, 10))
    } catch (err) {
      console.error('Failed to refresh data', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPrinters = useCallback(async () => {
    try {
      const list = await window.zuppy.getPrinters()
      setPrinters(list)
    } catch (err) {
      console.error('Failed to load printers', err)
    }
  }, [])

  useEffect(() => {
    refresh()
    loadPrinters()

    // Refresh every 5 seconds for queue depth
    const interval = setInterval(refresh, 5000)

    // Listen for push events from main process
    const unsub = window.zuppy.onUpdate((event) => {
      if (event === 'queueUpdate' || event === 'jobDone' || event === 'connected' || event === 'disconnected') {
        refresh()
      }
    })

    return () => {
      clearInterval(interval)
      unsub()
    }
  }, [refresh])

  // ── Config changes ────────────────────────────────────────────────────────

  async function handlePrinterChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const printer_name = e.target.value
    setConfig((c) => ({ ...c, printer_name }))
    await window.zuppy.saveConfig({ printer_name })
    await refresh()
  }

  async function handlePaperSizeChange(size: '80mm' | '58mm') {
    setConfig((c) => ({ ...c, paper_size: size }))
    await window.zuppy.saveConfig({ paper_size: size })
  }

  // ── Test print ────────────────────────────────────────────────────────────

  async function handleTestPrint() {
    setTestPrinting(true)
    setTestResult(null)
    try {
      await window.zuppy.testPrint(config.printer_name)
      setTestResult('✅ Impressão de teste enviada!')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTestResult(`❌ Erro: ${msg}`)
    } finally {
      setTestPrinting(false)
      setTimeout(() => setTestResult(null), 5000)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <span style={{ color: '#94a3b8' }}>Carregando…</span>
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f172a',
        color: '#f1f5f9',
        fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header
        style={{
          background: '#1e293b',
          borderBottom: '1px solid #334155',
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Logo / Title */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>🖨️ Zuppy Impressora</div>
            {config.tenant_name && (
              <div style={{ color: '#94a3b8', fontSize: 12 }}>{config.tenant_name}</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Queue depth */}
          {(status?.queue ?? 0) > 0 && (
            <div
              style={{
                background: '#f97316',
                color: '#fff',
                borderRadius: 20,
                padding: '2px 10px',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {status?.queue} na fila
            </div>
          )}

          {/* Status badge */}
          {status && <StatusBadge status={status.status} />}

          {/* Version */}
          <span style={{ color: '#475569', fontSize: 11 }}>v{status?.version}</span>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Not configured warning */}
        {status?.status === 'not_configured' && (
          <div
            style={{
              background: '#7f1d1d',
              border: '1px solid #ef4444',
              borderRadius: 8,
              padding: '12px 16px',
              fontSize: 13,
              color: '#fca5a5',
            }}
          >
            ⚠️ Impressora não configurada. Acesse o painel da Zuppy e conecte esta impressora.
          </div>
        )}

        {/* ── Printer settings card ──────────────────────────────────── */}
        <section
          style={{
            background: '#1e293b',
            borderRadius: 10,
            border: '1px solid #334155',
            padding: 18,
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Configurações de Impressão
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Printer selector */}
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                Impressora
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  value={config.printer_name ?? ''}
                  onChange={handlePrinterChange}
                  style={{ flex: 1 }}
                >
                  <option value="">— Selecionar impressora —</option>
                  {printers.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <button
                  onClick={loadPrinters}
                  style={{ background: '#334155', color: '#f1f5f9', padding: '6px 12px' }}
                  title="Atualizar lista"
                >
                  🔄
                </button>
              </div>
            </div>

            {/* Paper size */}
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                Largura do Papel
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['80mm', '58mm'] as const).map((size) => (
                  <button
                    key={size}
                    onClick={() => handlePaperSizeChange(size)}
                    style={{
                      background: config.paper_size === size ? '#3b82f6' : '#334155',
                      color: '#f1f5f9',
                      padding: '6px 18px',
                      fontWeight: config.paper_size === size ? 600 : 400,
                    }}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            {/* Test print */}
            <div>
              <button
                onClick={handleTestPrint}
                disabled={!config.printer_name || testPrinting}
                style={{
                  background: '#22c55e',
                  color: '#fff',
                  padding: '9px 20px',
                  fontWeight: 600,
                }}
              >
                {testPrinting ? '⏳ Imprimindo…' : '🖨️  Imprimir Teste'}
              </button>
              {testResult && (
                <span style={{ marginLeft: 12, fontSize: 13 }}>{testResult}</span>
              )}
            </div>
          </div>
        </section>

        {/* ── Recent prints card ─────────────────────────────────────── */}
        <section
          style={{
            background: '#1e293b',
            borderRadius: 10,
            border: '1px solid #334155',
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <h2
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              padding: '14px 18px',
              borderBottom: '1px solid #334155',
            }}
          >
            Últimas Impressões
          </h2>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {logs.length === 0 ? (
              <div
                style={{
                  padding: 24,
                  color: '#475569',
                  fontSize: 13,
                  textAlign: 'center',
                }}
              >
                Nenhuma impressão registrada ainda.
              </div>
            ) : (
              logs.map((l) => <LogRow key={l.id + l.timestamp} log={l} />)
            )}
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer
        style={{
          background: '#1e293b',
          borderTop: '1px solid #334155',
          padding: '8px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 11,
          color: '#475569',
        }}
      >
        <span>Zuppy Impressora © 2026 Zuppy Food</span>
        <span>Servidor: http://127.0.0.1:7847</span>
      </footer>
    </div>
  )
}

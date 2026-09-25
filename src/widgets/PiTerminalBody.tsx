import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { WidgetElement, AgentThinkingLevel } from '../lib/types'
import { connectManagedPi, managedPiPromptControl, type ManagedPiRuntime } from '../lib/pi-runtime'
import type { CompanionEvent } from '../lib/pi-companion-protocol'
import { registerTransport, unregisterTransport, useAgents, ensureNotifyPermission, looksLikePrompt, notify } from '../lib/agents'
import { useStore, selectActive } from '../store/workspace'
import { onAgentTurnComplete } from '../lib/flow'

const BASE_FONT = 12.5

type Props = { workspaceId: string; el: WidgetElement; active: boolean; visible?: boolean }

export function PiTerminalBody({ workspaceId, el, active, visible = true }: Props) {
  const runtimeId = `${workspaceId}:${el.id}`
  const hostRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const runtimeRef = useRef<ManagedPiRuntime | null>(null)
  const workingSince = useRef<number | null>(null)
  const turnIndex = useRef(0)
  const turnText = useRef('')
  const textTail = useRef('')
  const ptyTail = useRef('')
  const kRef = useRef(1)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'warning' | 'error'>('connecting')
  const [error, setError] = useState<string>()
  const [armed, setArmed] = useState(visible)
  const [k, setK] = useState(() => {
    const value = Math.max(1, selectActive(useStore.getState()).camera.zoom)
    kRef.current = value
    return value
  })
  const mutateElementInTab = useStore(state => state.mutateElementInTab)

  useEffect(() => {
    if (visible) setArmed(true)
  }, [visible])

  useEffect(() => {
    if (!armed || !hostRef.current || !innerRef.current) return
    let disposed = false
    let transportOwner: symbol | undefined
    const terminal = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: BASE_FONT * kRef.current,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      theme: {
        background: '#0a0b0d', foreground: '#e8e6e1', cursor: '#c89bd6', cursorAccent: '#0a0b0d',
        selectionBackground: 'rgba(200,155,214,0.25)', black: '#1a1d24', red: '#e8795a',
        green: '#8bbf73', yellow: '#d8a657', blue: '#6db5a8', magenta: '#c89bd6',
        cyan: '#7fc7c0', white: '#c8c6c0', brightBlack: '#61605b', brightRed: '#f08e72',
        brightGreen: '#a6d189', brightYellow: '#e5c07b', brightBlue: '#82c7bb',
        brightMagenta: '#d9b3e3', brightCyan: '#98d4cd', brightWhite: '#e8e6e1',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(innerRef.current)
    termRef.current = terminal
    fitRef.current = fit
    const ptyDecoder = new TextDecoder('utf-8')
    const input = terminal.onData(data => {
      ptyTail.current = ''
      runtimeRef.current?.send(data)
      if (useAgents.getState().status[runtimeId] === 'waiting') {
        useAgents.getState().setStatus(runtimeId, 'working')
      }
    })
    const resize = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit()
          runtimeRef.current?.resize(terminal.cols, terminal.rows)
        } catch { /* hidden/unmeasurable */ }
      })
    })
    resize.observe(hostRef.current)
    const connectFrame = requestAnimationFrame(() => {
      try { fit.fit() } catch { /* hidden/unmeasurable */ }
      useAgents.getState().setStatus(runtimeId, 'connecting')
      void connectManagedPi({
        id: runtimeId,
        widgetId: el.id,
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: el.cwd || '~',
        sessionFile: el.sessionFile,
        provider: el.provider,
        model: el.model,
        thinkingLevel: el.thinkingLevel,
      }, {
        onData: data => {
          terminal.write(data)
          ptyTail.current = (ptyTail.current + ptyDecoder.decode(data, { stream: true })).slice(-800)
          const status = useAgents.getState().status[runtimeId]
          if ((status === 'working' || status === 'waiting') && looksLikePrompt(ptyTail.current)) {
            useAgents.getState().setStatus(runtimeId, 'waiting')
          }
        },
        onEvent: (frame, delivery) => {
          if (frame.type !== 'event') return
          handleEvent(frame, delivery.replayed)
        },
        onStatus: status => {
          if (status.connected) {
            setConnection(status.error ? 'warning' : 'connected')
            setError(status.error)
            if (useAgents.getState().status[runtimeId] !== 'working') {
              useAgents.getState().setStatus(runtimeId, 'idle')
            }
          } else if (status.error) {
            setConnection('error')
            setError(status.error)
            useAgents.getState().setStatus(runtimeId, 'off')
          }
        },
        onExit: () => {
          setConnection('error')
          setError('Pi process exited')
          useAgents.getState().setStatus(runtimeId, 'off')
        },
      }).then(runtime => {
        if (disposed) {
          runtime.close()
          return
        }
        runtimeRef.current = runtime
        transportOwner = registerTransport(runtimeId, {
          send: data => runtime.send(data),
          prompt: text => runtime.control(managedPiPromptControl(
            text,
            ['working', 'waiting'].includes(useAgents.getState().status[runtimeId]),
          )).then(() => undefined),
          rename: name => runtime.control({ type: 'rename', name }).then(() => undefined),
          kind: 'agent',
          title: el.title,
        })
        void ensureNotifyPermission()
        runtime.start()
      }).catch(reason => {
        if (disposed) return
        const message = reason instanceof Error ? reason.message : String(reason)
        setConnection('error')
        setError(message)
        useAgents.getState().setStatus(runtimeId, 'off')
        terminal.writeln(`\r\n\x1b[31mccanvas Pi runtime: ${message}\x1b[0m`)
      })
    })

    function handleEvent(frame: CompanionEvent, replayed: boolean) {
      const event = frame.event
      if (event.type === 'runtime_error') {
        if (event.code === 'replay_gap') {
          setConnection('warning')
          setError(event.message)
        } else if (event.code === 'replay_reset_complete') {
          setConnection('connected')
          setError(undefined)
        }
        return
      }
      if (event.type === 'session') {
        if (event.phase === 'start' || event.phase === 'info') {
          const current = useStore.getState().tabs
            .find(tab => tab.id === workspaceId)
            ?.elements.find(element => element.id === el.id)
          const unchanged = current?.type === 'widget'
            && current.kind === 'agent'
            && current.harness === 'pi'
            && current.sessionId === event.sessionId
            && current.sessionFile === event.sessionFile
            && (!event.model || (current.provider === event.model.provider && current.model === event.model.id))
            && (!event.thinkingLevel || current.thinkingLevel === event.thinkingLevel)
          if (unchanged) return
          mutateElementInTab(workspaceId, el.id, current => {
            if (current.type !== 'widget' || current.kind !== 'agent' || current.harness !== 'pi') return
            current.sessionId = event.sessionId
            current.sessionFile = event.sessionFile
            if (event.model) {
              current.provider = event.model.provider
              current.model = event.model.id
            }
            if (event.thinkingLevel) current.thinkingLevel = event.thinkingLevel as AgentThinkingLevel
          })
        }
        return
      }
      if (event.type === 'lifecycle') {
        if (event.phase === 'agent_start') {
          if (!replayed) {
            turnIndex.current += 1
            turnText.current = ''
          }
          workingSince.current = replayed ? null : Date.now()
          useAgents.getState().setStatus(runtimeId, 'working')
        } else if (event.phase === 'agent_settled') {
          const started = workingSince.current
          if (!replayed && started != null) useAgents.getState().recordTurn(runtimeId, Date.now() - started)
          workingSince.current = null
          useAgents.getState().setStatus(runtimeId, 'idle')
          if (!replayed) {
            void onAgentTurnComplete(el.id, turnIndex.current, turnText.current, workspaceId)
            const store = useStore.getState()
            const activelyViewed = store.activeTabId === workspaceId
              && store.activeWidgetId === el.id
              && document.hasFocus()
            if (!activelyViewed) {
              notify(el.title || 'Pi agent', event.outcome === 'failed' ? 'run failed' : 'ready')
            }
          }
        }
        return
      }
      if (event.type === 'assistant' && event.phase === 'delta' && event.text) {
        turnText.current = (turnText.current + event.text).slice(-6_000)
        textTail.current = (textTail.current + event.text).slice(-240)
        const lines = textTail.current.split('\n').filter(Boolean)
        const line = lines[lines.length - 1]?.trim()
        if (line) useAgents.getState().setLastLine(runtimeId, line)
      }
      if (event.type === 'tool' && event.phase === 'start') {
        useAgents.getState().setLastLine(runtimeId, `tool · ${event.name}`)
      }
    }

    return () => {
      disposed = true
      cancelAnimationFrame(connectFrame)
      resize.disconnect()
      input.dispose()
      if (unregisterTransport(runtimeId, transportOwner)) {
        useAgents.getState().clear(runtimeId)
      }
      runtimeRef.current?.close()
      runtimeRef.current = null
      fit.dispose()
      terminal.dispose()
      fitRef.current = null
      termRef.current = null
    }
  // A live backend owns configuration for its process generation. Changing
  // config requires explicit widget/runtime replacement, never silent relaunch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = useStore.subscribe(state => {
      const next = Math.max(1, selectActive(state).camera.zoom)
      if (Math.abs(next - kRef.current) < 0.01) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        kRef.current = next
        setK(next)
      }, 150)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const terminal = termRef.current
    if (!terminal) return
    terminal.options.fontSize = BASE_FONT * k
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        runtimeRef.current?.resize(terminal.cols, terminal.rows)
      } catch { /* hidden/unmeasurable */ }
    })
    return () => cancelAnimationFrame(frame)
  }, [k, armed])

  useEffect(() => {
    if (!visible) return
    const terminal = termRef.current
    if (!terminal) return
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        terminal.refresh(0, terminal.rows - 1)
        runtimeRef.current?.resize(terminal.cols, terminal.rows)
      } catch { /* hidden/unmeasurable */ }
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    const terminal = termRef.current
    if (!terminal) return
    if (terminal.hasSelection()) {
      const selection = terminal.getSelection()
      if (selection) void navigator.clipboard.writeText(selection)
      terminal.clearSelection()
    } else {
      void navigator.clipboard.readText().then(text => { if (text) terminal.paste(text) }).catch(() => {})
    }
  }

  return (
    <div className="term" onContextMenu={onContextMenu}>
      <div ref={hostRef} className="term__screen">
        <div
          ref={innerRef}
          className="term__inner"
          style={{
            width: `${k * 100}%`, height: `${k * 100}%`,
            transform: `scale(${1 / k})`, transformOrigin: 'top left',
          }}
        />
      </div>
      <div className="term__status">
        <span className={`term__dot ${connection === 'connected' ? 'term__dot--on' : 'term__dot--off'}`} />
        {connection === 'connected'
          ? 'pi · managed TUI'
          : connection === 'warning'
            ? `pi · connected · ${error}`
            : connection === 'error'
              ? `pi · ${error}`
              : 'pi · connecting…'}
      </div>
    </div>
  )
}

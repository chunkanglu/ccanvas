// Existing xterm dependency, parser/buffer only. No DOM or model calls.
import xterm from '@xterm/xterm'
import readline from 'node:readline'
const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true })
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
terminal.onData(reply => send({ reply }))
readline.createInterface({ input: process.stdin }).on('line', line => {
  terminal.write(Buffer.from(JSON.parse(line).data, 'base64'), () => {
    const lines = []
    const buffer = terminal.buffer.active
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i).translateToString(true))
    send({ lines, current: buffer.getLine(buffer.baseY + buffer.cursorY).translateToString(true), cursorX: buffer.cursorX })
  })
}).on('close', () => terminal.dispose())

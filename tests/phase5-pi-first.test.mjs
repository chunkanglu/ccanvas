import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}tests/fixtures/phase5-entry.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const phase5 = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

test('new agents default to Pi while legacy templates without harness stay Claude', () => {
  const workspace = { id: 'ws', name: 'test', elements: [], camera: { x: 0, y: 0, zoom: 1 }, dir: '/repo' }
  phase5.useStore.setState({ tabs: [workspace], activeTabId: 'ws', templates: [] })
  const id = phase5.useStore.getState().spawnWidget('agent', 0, 0)
  let agent = phase5.useStore.getState().tabs[0].elements.find(element => element.id === id)
  assert.equal(agent.harness, 'pi')
  assert.equal(agent.sessionId, undefined, 'Pi owns session identity after launch')
  assert.equal(agent.title, 'agent')

  phase5.useStore.setState({
    templates: [{
      id: 'legacy', name: 'legacy', createdAt: 1,
      widgets: [{ kind: 'agent', dx: 0, dy: 0, w: 600, h: 400, model: 'sonnet' }],
    }],
  })
  phase5.useStore.getState().applyTemplate('legacy', 0, 0)
  agent = phase5.useStore.getState().tabs[0].elements.at(-1)
  assert.equal(agent.harness, 'claude')
  assert.match(agent.sessionId, /^[0-9a-f-]{36}$/)
})

test('creation entry points are Pi-first and keep Claude as explicit legacy', async () => {
  const read = path => readFile(`${root}${path}`, 'utf8')
  const [wizard, palette, canvas, toolbar, welcome] = await Promise.all([
    read('src/ui/AgentWizard.tsx'),
    read('src/ui/CommandPalette.tsx'),
    read('src/canvas/Canvas.tsx'),
    read('src/ui/Toolbar.tsx'),
    read('src/ui/Welcome.tsx'),
  ])
  assert.match(wizard, /ctx\.harness \?\? 'pi'/)
  assert.match(wizard, /\['pi', 'claude'\]/)
  assert.match(wizard, /Create Pi agent from this configuration/)
  assert.doesNotMatch(palette, /AGENT_MODELS|opus|sonnet|haiku/)
  assert.match(palette, /New: Claude agent \(legacy\)/)
  assert.match(palette, /harness: 'pi',\n\s+cwd: wtPath/)
  assert.match(canvas, /name: 'claude', target: 'agent', desc: 'Claude agent \(legacy\)'/)
  assert.match(canvas, /head\.toLowerCase\(\) === 'claude' \? 'claude' : 'pi'/)
  assert.match(toolbar, /openAgentWizard\(\{ x, y, harness: 'pi' \}\)/)
  assert.match(welcome, /harness: 'pi'/)
})

test('Pi launch profiles store only bounded nonsecret defaults', () => {
  const storage = memoryStorage()
  phase5.rememberPiLaunchProfile({ provider: 'openai', model: 'gpt-x', thinkingLevel: 'high', apiKey: 'secret' }, storage)
  phase5.rememberPiLaunchProfile({ provider: 'anthropic', model: 'claude-y' }, storage)
  phase5.rememberPiLaunchProfile({ provider: 'openai', model: 'gpt-x', thinkingLevel: 'high' }, storage)
  const profiles = phase5.loadPiLaunchProfiles(storage)
  assert.deepEqual(profiles, [
    { provider: 'openai', model: 'gpt-x', thinkingLevel: 'high' },
    { provider: 'anthropic', model: 'claude-y' },
  ])
  assert.doesNotMatch(JSON.stringify(profiles), /secret|apiKey/)
  assert.equal(phase5.normalizePiLaunchProfile({ model: 'bad\nmodel' }), null)
  assert.equal(phase5.piLaunchProfileLabel(profiles[0]), 'openai/gpt-x · high')
  let bounded = []
  for (let index = 0; index < 10; index++) bounded = phase5.mergePiLaunchProfile(bounded, { model: `m${index}` })
  assert.equal(bounded.length, 6)
})

test('attached Pi usage counts duplicate session views once and keeps unknown context unknown', () => {
  const usage = (sessionId, total, costUsd, context) => ({
    sessionId,
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
    costUsd,
    assistantMessages: 1,
    toolCalls: 0,
    context,
  })
  const aggregate = phase5.aggregatePiUsage({
    'ws-a:agent': usage('s1', 100, 0.1, { tokens: 20, window: 100, percent: 20 }),
    'ws-b:agent': usage('s1', 120, 0.12, { tokens: null, window: 100, percent: null }),
    'ws-a:other': usage('s2', 50, 0.05, { tokens: 10, window: 100, percent: 10 }),
    'ws-a:new': usage(undefined, 5, 0.01),
  })
  assert.equal(aggregate.sessions, 3)
  assert.equal(aggregate.tokens, 175)
  assert.equal(Math.round(aggregate.costUsd * 100), 18)
  assert.equal(aggregate.unknownContext, 2)
})

test('knowledge graph resolves paths, aliases and unique names without guessing ambiguity', () => {
  const nodes = [
    phase5.parseKnowledgeNote('Tooling/Pi.md', '---\naliases: [pi agent]\n---\nSee [[Tooling/Canvas]] and [[Shared]].'),
    phase5.parseKnowledgeNote('Tooling/Canvas.md', 'Linked from [[pi agent|Pi]] and [[Missing]].'),
    phase5.parseKnowledgeNote('A/Shared.md', 'first'),
    phase5.parseKnowledgeNote('B/Shared.md', 'second'),
    phase5.parseKnowledgeNote('Unique.md', '---\ntitle: Human title\n---\nSee [[Canvas#section]].'),
  ]
  const graph = phase5.buildKnowledgeGraph(nodes)
  const links = graph.links.map(link => link.slice().sort().join(' <-> ')).sort()
  assert.deepEqual(links, ['Tooling/Canvas <-> Tooling/Pi', 'Tooling/Canvas <-> Unique'])
  assert.equal(graph.ambiguousLinks, 1)
  assert.equal(nodes.find(node => node.id === 'Unique').label, 'Human title')
})

test('Markdown knowledge loading is read-only, bounded and skips hidden/dependency folders', async () => {
  const listings = new Map([
    ['/vault', [
      { name: '.obsidian', path: '/vault/.obsidian', is_dir: true },
      { name: 'node_modules', path: '/vault/node_modules', is_dir: true },
      { name: 'notes', path: '/vault/notes', is_dir: true },
      { name: 'root.md', path: '/vault/root.md', is_dir: false },
      { name: 'huge.md', path: '/vault/huge.md', is_dir: false },
    ]],
    ['/vault/notes', [{ name: 'child.md', path: '/vault/notes/child.md', is_dir: false }]],
  ])
  const reads = []
  const graph = await phase5.loadMarkdownKnowledge('/vault', {
    listDir: async path => listings.get(path) ?? [],
    readFile: async path => {
      reads.push(path)
      if (path.endsWith('huge.md')) return 'x'.repeat(phase5.KNOWLEDGE_LIMITS.maxNoteChars + 1)
      return path.endsWith('root.md') ? 'Links [[child]]' : 'child'
    },
  })
  assert.deepEqual(graph.nodes.map(node => node.id).sort(), ['notes/child', 'root'])
  assert.equal(graph.links.length, 1)
  assert.equal(graph.truncated, true)
  assert.equal(reads.some(path => path.includes('.obsidian') || path.includes('node_modules')), false)
})

test('graph and usage UI label source/scope explicitly', async () => {
  const graph = await readFile(`${root}src/widgets/KnowledgeGraphBody.tsx`, 'utf8')
  const usage = await readFile(`${root}src/ui/UsagePill.tsx`, 'utf8')
  const store = await readFile(`${root}src/store/workspace.ts`, 'utf8')
  assert.match(graph, /claude · memory \(legacy\)/)
  assert.match(graph, /does not scan a whole vault by default/)
  assert.match(store, /graphSource: 'markdown'/)
  assert.match(usage, /Attached Pi sessions/)
  assert.match(usage, /not bills or account/)
  assert.match(usage, /Claude Code \(legacy\)/)
})

import type { DirEntry } from './backend'

export type KnowledgeNode = {
  /** Stable source-relative identity. */
  id: string
  /** Display title from frontmatter `name`/`title`, otherwise the basename. */
  label: string
  type: string
  desc: string
  body: string
  aliases: string[]
  links: string[]
  deg: number
  x: number
  y: number
  vx: number
  vy: number
  hub: boolean
}

export type KnowledgeGraph = {
  nodes: KnowledgeNode[]
  links: [string, string][]
  /** Input bounds omitted some notes. */
  truncated: boolean
  /** Wikilinks omitted because more than one note matched. */
  ambiguousLinks: number
}

export const KNOWLEDGE_LIMITS = {
  maxNotes: 400,
  maxDepth: 4,
  maxNoteChars: 256 * 1024,
  maxDirectories: 800,
} as const

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__'])
const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, '').trim()
const normalizeKey = (value: string) => value.normalize('NFC').toLocaleLowerCase()
const basename = (path: string) => path.split('/').pop() ?? path

function frontmatterList(frontmatter: string, key: string): string[] {
  const inline = frontmatter.match(new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm'))
  if (inline) return inline[1].split(',').map(unquote).filter(Boolean)
  const single = frontmatter.match(new RegExp(`^${key}:\\s*(\\S.*)$`, 'm'))
  if (single) return [unquote(single[1])].filter(Boolean)
  const block = frontmatter.match(new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, 'm'))
  if (!block) return []
  return block[1].split('\n').map(line => unquote(line.replace(/^\s*-\s*/, ''))).filter(Boolean)
}

/** Parse one Markdown note. `relativePath` uses forward slashes and includes `.md`. */
export function parseKnowledgeNote(relativePath: string, text: string, fallbackType = 'note'): KnowledgeNode {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  const frontmatter = match ? match[1] : ''
  const body = (match ? match[2] : text).trim()
  const id = relativePath.replace(/\\/g, '/').replace(/\.md$/i, '')
  const label = unquote(
    frontmatter.match(/^name:\s*(.+)$/m)?.[1]
      ?? frontmatter.match(/^title:\s*(.+)$/m)?.[1]
      ?? basename(id),
  )
  const desc = unquote(frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? '')
  const type = (frontmatter.match(/^\s*type:\s*([\w-]+)/m)?.[1] ?? fallbackType).trim()
  const links = Array.from(body.matchAll(/!?\[\[([^\]\n]+)\]\]/g)).map(item => item[1].trim())
  return {
    id,
    label,
    type,
    desc,
    body,
    aliases: frontmatterList(frontmatter, 'aliases'),
    links,
    deg: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    hub: false,
  }
}

function linkTarget(raw: string): string {
  return raw
    .split('|')[0]
    .split('#')[0]
    .split('^')[0]
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/\.md$/i, '')
}

/**
 * Resolve wikilinks by exact relative path, then explicit aliases, then a
 * unique basename/title. Ambiguous names are dropped instead of guessed.
 */
export function buildKnowledgeGraph(nodes: KnowledgeNode[], truncated = false): KnowledgeGraph {
  const byPath = new Map<string, KnowledgeNode>()
  const named = new Map<string, KnowledgeNode[]>()
  const aliasMap = new Map<string, KnowledgeNode[]>()
  const addName = (map: Map<string, KnowledgeNode[]>, key: string, node: KnowledgeNode) => {
    const normalized = normalizeKey(key)
    const list = map.get(normalized) ?? []
    if (!list.includes(node)) list.push(node)
    map.set(normalized, list)
  }
  for (const node of nodes) {
    node.deg = 0
    node.hub = false
    byPath.set(normalizeKey(node.id), node)
    addName(named, basename(node.id), node)
    addName(named, node.label, node)
    for (const alias of node.aliases) addName(aliasMap, alias, node)
  }

  let ambiguousLinks = 0
  const seen = new Set<string>()
  const links: [string, string][] = []
  const resolve = (raw: string): KnowledgeNode | undefined => {
    const target = linkTarget(raw)
    if (!target) return undefined
    const key = normalizeKey(target)
    const exact = byPath.get(key)
    if (exact) return exact
    for (const map of [aliasMap, named]) {
      const candidates = map.get(key) ?? []
      if (candidates.length === 1) return candidates[0]
      if (candidates.length > 1) {
        ambiguousLinks += 1
        return undefined
      }
    }
    return undefined
  }
  for (const node of nodes) {
    for (const raw of node.links) {
      const target = resolve(raw)
      if (!target || target === node) continue
      const key = [node.id, target.id].sort().join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      links.push([node.id, target.id])
      node.deg += 1
      target.deg += 1
    }
  }
  const hub = nodes.reduce<KnowledgeNode | undefined>(
    (best, node) => (!best || node.deg > best.deg ? node : best),
    undefined,
  )
  if (hub) hub.hub = true
  return { nodes, links, truncated, ambiguousLinks }
}

type Reader = {
  listDir(path: string): Promise<DirEntry[] | null>
  readFile(path: string): Promise<string | null>
}

function relativeTo(root: string, path: string): string {
  const cleanRoot = root.replace(/[\\/]+$/, '')
  return path.startsWith(cleanRoot)
    ? path.slice(cleanRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : basename(path.replace(/\\/g, '/'))
}

/** Read-only bounded Markdown folder traversal. Hidden and dependency/build folders are skipped. */
export async function loadMarkdownKnowledge(root: string, reader: Reader): Promise<KnowledgeGraph | null> {
  const rootEntries = await reader.listDir(root)
  if (!rootEntries) return null
  const queue: Array<{ path: string; depth: number; entries?: DirEntry[] }> = [{ path: root, depth: 0, entries: rootEntries }]
  const files: DirEntry[] = []
  let truncated = false
  let directories = 0
  while (queue.length) {
    const current = queue.shift()!
    directories += 1
    if (directories > KNOWLEDGE_LIMITS.maxDirectories) {
      truncated = true
      break
    }
    const entries = current.entries ?? await reader.listDir(current.path)
    if (!entries) continue
    const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of sorted) {
      if (entry.name.startsWith('.')) continue
      if (entry.is_dir) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        if (current.depth + 1 > KNOWLEDGE_LIMITS.maxDepth) {
          truncated = true
          continue
        }
        queue.push({ path: entry.path, depth: current.depth + 1 })
      } else if (/\.md$/i.test(entry.name)) {
        if (files.length >= KNOWLEDGE_LIMITS.maxNotes) {
          truncated = true
          continue
        }
        files.push(entry)
      }
    }
    if (files.length >= KNOWLEDGE_LIMITS.maxNotes && queue.length) truncated = true
    if (files.length >= KNOWLEDGE_LIMITS.maxNotes) break
  }

  const texts = await Promise.all(files.map(file => reader.readFile(file.path)))
  const nodes: KnowledgeNode[] = []
  files.forEach((file, index) => {
    const text = texts[index]
    if (text == null) return
    if (text.length > KNOWLEDGE_LIMITS.maxNoteChars) {
      truncated = true
      return
    }
    const relative = relativeTo(root, file.path)
    const folder = relative.includes('/') ? relative.split('/')[0] : 'note'
    nodes.push(parseKnowledgeNote(relative, text, folder))
  })
  return buildKnowledgeGraph(nodes, truncated)
}

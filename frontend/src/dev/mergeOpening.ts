/**
 * Dev-only: merge a raw opening file (data/openings schema) into the `OpeningFull` shape the
 * backend serves. Mirrors backend/app/openings.py so the playground can render a tree without
 * the server. NOT used by the tabs (they get trees from /api/openings/{id}).
 */
import { Chess } from 'chess.js'
import type { LineCategory, LineMeta, OpeningFile, OpeningFull, OpeningNode } from '../api/types'
import { START_FEN, moveToUci } from '../lib/chess'

function newNode(parent: OpeningNode, san: string, uci: string, fen: string): OpeningNode {
  return {
    id: parent.id ? `${parent.id} ${san}` : san,
    san,
    uci,
    fen,
    ply: parent.ply + 1,
    why: '',
    nag: '',
    lineIds: [],
    mainLine: false,
    categories: [],
    children: [],
  }
}

function sortChildren(node: OpeningNode): void {
  node.children.sort((a, b) => {
    if (a.mainLine !== b.mainLine) return a.mainLine ? -1 : 1
    if (a.lineIds.length !== b.lineIds.length) return b.lineIds.length - a.lineIds.length
    return a.san.localeCompare(b.san)
  })
  node.children.forEach(sortChildren)
}

export function mergeOpeningFile(file: OpeningFile): OpeningFull {
  const root: OpeningNode = {
    id: '',
    san: '',
    uci: '',
    fen: START_FEN,
    ply: 0,
    why: '',
    nag: '',
    lineIds: [],
    mainLine: false,
    categories: [],
    children: [],
  }
  const lines: LineMeta[] = []
  const categoriesCount: Partial<Record<LineCategory, number>> = {}

  for (const line of file.lines) {
    const chess = new Chess()
    let node = root
    const sans: string[] = []
    for (const mv of line.moves) {
      const move = chess.move(mv.san.replace('0-0-0', 'O-O-O').replace('0-0', 'O-O'))
      sans.push(move.san)
      let child = node.children.find((c) => c.san === move.san)
      if (!child) {
        child = newNode(node, move.san, moveToUci(move), chess.fen())
        node.children.push(child)
      }
      if (!child.lineIds.includes(line.id)) child.lineIds.push(line.id)
      const why = (mv.why ?? '').trim()
      if (why && why.length > child.why.length) child.why = why
      if (!child.nag && mv.nag) child.nag = mv.nag
      if (line.category === 'main') child.mainLine = true
      if (!child.categories.includes(line.category)) child.categories.push(line.category)
      node = child
    }
    lines.push({
      id: line.id,
      name: line.name,
      category: line.category,
      description: line.description,
      evaluation: line.evaluation ?? '',
      sans,
      finalFen: chess.fen(),
    })
    categoriesCount[line.category] = (categoriesCount[line.category] ?? 0) + 1
  }
  sortChildren(root)
  const main = lines.find((l) => l.category === 'main')

  return {
    id: file.id,
    name: file.name,
    side: file.side,
    eco: file.eco ?? '',
    family: file.family ?? '',
    summary: file.summary,
    lineCount: lines.length,
    mainLineSans: main?.sans ?? [],
    categoriesCount,
    keyIdeas: file.keyIdeas,
    typicalPlans: file.typicalPlans ?? [],
    commonMistakes: file.commonMistakes ?? [],
    sources: file.sources ?? [],
    lines,
    tree: root,
  }
}

/**
 * Helpers for the merged opening tree (`OpeningNode`, see ARCHITECTURE.md).
 * Node ids are the SAN path joined by a single space; the root id is "".
 */
import type { LineMeta, OpeningNode } from '../api/types'

export function nodeIdFromSans(sans: readonly string[]): string {
  return sans.join(' ')
}

export function sansFromNodeId(id: string): string[] {
  return id === '' ? [] : id.split(' ')
}

/** Depth-first visitor (root first). Return `false` from `fn` to stop descending into that node. */
export function walkTree(root: OpeningNode, fn: (node: OpeningNode, parent: OpeningNode | null) => boolean | void): void {
  const visit = (node: OpeningNode, parent: OpeningNode | null) => {
    if (fn(node, parent) === false) return
    for (const c of node.children) visit(c, node)
  }
  visit(root, null)
}

/** Every node in the tree (root included), depth first. */
export function collectNodes(root: OpeningNode): OpeningNode[] {
  const out: OpeningNode[] = []
  walkTree(root, (n) => {
    out.push(n)
  })
  return out
}

/** Find a node by id (SAN path string). O(depth) because ids encode the path. */
export function findNodeById(root: OpeningNode, id: string): OpeningNode | null {
  return findNodeByPath(root, sansFromNodeId(id))
}

/** Follow a SAN path from the root. Returns null if the path leaves the tree. */
export function findNodeByPath(root: OpeningNode, sans: readonly string[]): OpeningNode | null {
  let node: OpeningNode | null = root
  for (const san of sans) {
    if (!node) return null
    node = node.children.find((c) => c.san === san) ?? null
  }
  return node
}

/** Longest prefix of `sans` that is in the tree, as the node reached (root if no move matches). */
export function deepestNodeOnPath(root: OpeningNode, sans: readonly string[]): { node: OpeningNode; matched: number } {
  let node = root
  let matched = 0
  for (const san of sans) {
    const next = node.children.find((c) => c.san === san)
    if (!next) break
    node = next
    matched += 1
  }
  return { node, matched }
}

/** Nodes from the root (excluded) down to and including the node with `id`; null if not found. */
export function pathToNode(root: OpeningNode, id: string): OpeningNode[] | null {
  const sans = sansFromNodeId(id)
  const path: OpeningNode[] = []
  let node: OpeningNode | null = root
  for (const san of sans) {
    node = node.children.find((c) => c.san === san) ?? null
    if (!node) return null
    path.push(node)
  }
  return path
}

/** Parent of the node with `id`, or null for the root / unknown ids. */
export function parentOf(root: OpeningNode, id: string): OpeningNode | null {
  const sans = sansFromNodeId(id)
  if (sans.length === 0) return null
  return findNodeByPath(root, sans.slice(0, -1))
}

/** The main line as nodes (root excluded): follows `mainLine` children, else the first child. */
export function mainLinePath(root: OpeningNode): OpeningNode[] {
  const out: OpeningNode[] = []
  let node = root
  while (node.children.length > 0) {
    const next = node.children.find((c) => c.mainLine) ?? node.children[0]
    out.push(next)
    node = next
  }
  return out
}

/** Every root-to-leaf path (root excluded). Main line first because children are ordered that way. */
export function flattenLines(root: OpeningNode): OpeningNode[][] {
  const out: OpeningNode[][] = []
  const visit = (node: OpeningNode, acc: OpeningNode[]) => {
    if (node.children.length === 0) {
      if (acc.length) out.push(acc)
      return
    }
    for (const c of node.children) visit(c, [...acc, c])
  }
  visit(root, [])
  return out
}

/** Leaf nodes (end of each variation). */
export function leaves(root: OpeningNode): OpeningNode[] {
  return collectNodes(root).filter((n) => n.children.length === 0 && n.ply > 0)
}

/** Lines that END exactly at this node. */
export function linesEndingAt(node: OpeningNode, lines: readonly LineMeta[]): LineMeta[] {
  return lines.filter((l) => l.sans.length === node.ply && node.lineIds.includes(l.id))
}

/** Lines through a node, resolved to their metadata (order preserved from `lines`). */
export function linesThrough(node: OpeningNode, lines: readonly LineMeta[]): LineMeta[] {
  const set = new Set(node.lineIds)
  return lines.filter((l) => set.has(l.id))
}

/** Count nodes below (and excluding) `node`. */
export function subtreeSize(node: OpeningNode): number {
  let n = 0
  walkTree(node, () => {
    n += 1
  })
  return n - 1
}

/** Depth (max ply) of the subtree rooted at `node`. */
export function subtreeDepth(node: OpeningNode): number {
  let max = node.ply
  walkTree(node, (n) => {
    if (n.ply > max) max = n.ply
  })
  return max
}

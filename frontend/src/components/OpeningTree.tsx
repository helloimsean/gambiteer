/**
 * OpeningTree: collapsible rendering of the merged opening tree (lichess style).
 *
 *   1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Nf6 5.Ng5 h6 6.Nxf7 Kxf7 7.Nf3 Bf5
 *     | 7...e6 8.Bd3 c5 ...                 <- alternatives, indented, collapsible
 *     | 7...Bg4? 8.Ne5+! ...
 *   8.Bc4+ e6 9.O-O ...                     <- main continuation
 *
 * The main (first) child of a branch point stays inline, its siblings follow as indented
 * variation blocks, then the main line continues. Main-line moves are bold, NAGs are coloured,
 * and the names of lines ending at a node appear as small pills. Variations nested deeper than
 * `autoCollapseDepth` start collapsed; the branch holding `selectedId` is always expanded and the
 * selected move is scrolled into view.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import type { LineMeta, OpeningNode } from '../api/types'
import { scrollIntoViewWithin } from '../lib/dom'
import { t, tn } from '../lib/i18n'
import { linesEndingAt } from '../lib/tree'
import { Icon } from './Icon'
import './OpeningTree.css'

export interface OpeningTreeProps {
  root: OpeningNode
  /** Line metadata (from `OpeningFull.lines`); enables line-name pills and variation labels. */
  lines?: readonly LineMeta[]
  /** Id (SAN path) of the node to highlight and reveal. */
  selectedId?: string | null
  onSelect?: (node: OpeningNode) => void
  /** Variations nested deeper than this start collapsed (default 2). */
  autoCollapseDepth?: number
  /** Show line-name pills where lines end (default true). */
  showLineNames?: boolean
  className?: string
}

interface Ctx {
  lines: readonly LineMeta[]
  selectedId: string | null
  onSelect?: (node: OpeningNode) => void
  autoCollapseDepth: number
  showLineNames: boolean
  selectedRef: RefObject<HTMLButtonElement | null>
}

function nagClass(nag: string): string {
  if (nag === '!' || nag === '!!') return 'nag good'
  if (nag === '?' || nag === '??') return 'nag bad'
  return 'nag'
}

/** Does the subtree rooted at `node` contain the id? (ids are SAN paths, so a prefix check suffices) */
function containsId(node: OpeningNode, id: string | null): boolean {
  if (id === null) return false
  if (node.id === '') return true
  return id === node.id || id.startsWith(node.id + ' ')
}

function MoveToken({ node, ctx, forceNumber }: { node: OpeningNode; ctx: Ctx; forceNumber: boolean }): JSX.Element {
  const isWhite = node.ply % 2 === 1
  const num = Math.ceil(node.ply / 2)
  const selected = ctx.selectedId === node.id
  const ending = ctx.showLineNames ? linesEndingAt(node, ctx.lines) : []
  return (
    <>
      {isWhite ? <span className="tree-num">{num}.</span> : forceNumber ? <span className="tree-num">{num}…</span> : null}
      <button
        ref={selected ? ctx.selectedRef : undefined}
        type="button"
        className={`tree-move${node.mainLine ? ' main' : ''}${selected ? ' selected' : ''}`}
        title={node.why || undefined}
        data-node-id={node.id}
        onClick={() => ctx.onSelect?.(node)}
      >
        {node.san}
        {node.nag ? <span className={nagClass(node.nag)}>{node.nag}</span> : null}
      </button>
      {ending.map((l) => (
        <span key={l.id} className={`tree-line-name cat-${l.category}`} title={`${l.name} (${l.category})`}>
          {l.name}
        </span>
      ))}{' '}
    </>
  )
}

/**
 * Render the line that starts at `start` (shown only when `includeStart`; the root never is) and
 * follows first children. Whenever a node has
 * several children, the first child is rendered inline, the others as Variation blocks, and the
 * line continues in a new inline segment.
 */
function Line({ start, includeStart, depth, ctx }: { start: OpeningNode; includeStart: boolean; depth: number; ctx: Ctx }): JSX.Element {
  const blocks: ReactNode[] = []
  let segment: ReactNode[] = includeStart ? [<MoveToken key={start.id} node={start} ctx={ctx} forceNumber />] : []
  let node = start
  while (node.children.length > 0) {
    const [main, ...alts] = node.children
    segment.push(<MoveToken key={main.id} node={main} ctx={ctx} forceNumber={segment.length === 0} />)
    if (alts.length > 0) {
      blocks.push(
        <span className="tree-moves" key={`seg-${main.id}`}>
          {segment}
        </span>,
      )
      blocks.push(
        <div className="tree-branches" key={`alts-${main.id}`}>
          {alts.map((alt) => (
            <Variation key={alt.id} node={alt} depth={depth + 1} ctx={ctx} />
          ))}
        </div>,
      )
      segment = []
    }
    node = main
  }
  if (segment.length > 0) {
    blocks.push(
      <span className="tree-moves" key="seg-end">
        {segment}
      </span>,
    )
  }
  return <div className="tree-line">{blocks}</div>
}

function countPlies(node: OpeningNode): number {
  let max = node.ply
  const visit = (n: OpeningNode) => {
    if (n.ply > max) max = n.ply
    n.children.forEach(visit)
  }
  visit(node)
  return max - node.ply
}

function Variation({ node, depth, ctx }: { node: OpeningNode; depth: number; ctx: Ctx }): JSX.Element {
  const holdsSelection = containsId(node, ctx.selectedId)
  const [collapsed, setCollapsed] = useState(depth > ctx.autoCollapseDepth && !holdsSelection)
  // expand when the selection moves into this variation (state adjusted during render, React docs pattern)
  const [prevHolds, setPrevHolds] = useState(holdsSelection)
  if (prevHolds !== holdsSelection) {
    setPrevHolds(holdsSelection)
    if (holdsSelection) setCollapsed(false)
  }

  // label for a collapsed variation: the first line through this node
  const label = useMemo(() => ctx.lines.find((l) => node.lineIds.includes(l.id)) ?? null, [ctx.lines, node])
  const plies = countPlies(node)

  return (
    <div className={`tree-variation depth-${Math.min(depth, 4)}`}>
      <button
        type="button"
        className={`tree-toggle${collapsed ? ' collapsed' : ''}`}
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? t('Expand variation') : t('Collapse variation')}
        aria-expanded={!collapsed}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {collapsed ? (
        <span className="tree-moves">
          <MoveToken node={node} ctx={{ ...ctx, showLineNames: false }} forceNumber />
          {plies > 0 ? (
            <span className="tree-collapsed-hint">
              {tn(plies, '+{n} ply', '+{n} plies')}
            </span>
          ) : null}
          {label ? <span className={`tree-line-name cat-${label.category}`}>{label.name}</span> : null}
        </span>
      ) : (
        <Line start={node} includeStart depth={depth} ctx={ctx} />
      )}
    </div>
  )
}

/** Collapsible opening tree; click a move to select its node. */
export function OpeningTree({
  root,
  lines = [],
  selectedId = null,
  onSelect,
  autoCollapseDepth = 2,
  showLineNames = true,
  className,
}: OpeningTreeProps): JSX.Element {
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const ctx: Ctx = { lines, selectedId, onSelect, autoCollapseDepth, showLineNames, selectedRef }

  useEffect(() => {
    // after expansion effects have rendered the selected move
    const id = requestAnimationFrame(() => scrollIntoViewWithin(selectedRef.current, containerRef.current, 24))
    return () => cancelAnimationFrame(id)
  }, [selectedId])

  const cls = `opening-tree${className ? ` ${className}` : ''}`
  if (root.children.length === 0) {
    return (
      <div className={cls}>
        <div className="tree-empty">{t('This opening has no moves.')}</div>
      </div>
    )
  }

  return (
    <div className={cls} ref={containerRef}>
      <Line start={root} includeStart={false} depth={0} ctx={ctx} />
    </div>
  )
}

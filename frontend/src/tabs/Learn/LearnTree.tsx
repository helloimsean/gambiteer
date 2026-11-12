/**
 * LearnTree: the opening tree for the Learn tab (lichess style).
 *
 * Differences from the shared `OpeningTree` (which the Learn spec outgrew):
 *  - variation-name chips sit on the node where a line STARTS (the first node unique to it), and
 *    clicking a chip follows that line;
 *  - the active line's path is highlighted, and variations holding it open automatically;
 *  - main-line moves are bold and bright, the top-level main line slightly larger.
 */
import { LINE_CATEGORY_LABELS } from '../../api/types'
import { useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import type { LineMeta, OpeningNode } from '../../api/types'
import { Icon } from '../../components/Icon'
import { scrollIntoViewWithin } from '../../lib/dom'
import { t } from '../../lib/i18n'
import { learnLinesThroughSorted, learnNagClass, learnSubtreeHas } from './learnUtils'

export interface LearnTreeProps {
  root: OpeningNode
  lines: readonly LineMeta[]
  /** Current node id (SAN path). */
  selectedId: string
  activeLineId: string | null
  /** Node ids on the active line. */
  activeIds: ReadonlySet<string>
  /** Node id -> lines that start at that node. */
  chips: ReadonlyMap<string, LineMeta[]>
  onSelectNode: (node: OpeningNode) => void
  onSelectLine: (line: LineMeta, node: OpeningNode) => void
  /** Variations nested deeper than this start collapsed. */
  autoCollapseDepth: number
}

interface Ctx {
  lines: readonly LineMeta[]
  selectedId: string
  activeLineId: string | null
  activeEndId: string | null
  activeIds: ReadonlySet<string>
  chips: ReadonlyMap<string, LineMeta[]>
  onSelectNode: (node: OpeningNode) => void
  onSelectLine: (line: LineMeta, node: OpeningNode) => void
  autoCollapseDepth: number
  selectedRef: RefObject<HTMLButtonElement | null>
}

function MoveToken({ node, ctx, forceNumber, showChips = true }: { node: OpeningNode; ctx: Ctx; forceNumber: boolean; showChips?: boolean }): JSX.Element {
  const isWhite = node.ply % 2 === 1
  const num = Math.ceil(node.ply / 2)
  const selected = ctx.selectedId === node.id
  const onLine = ctx.activeIds.has(node.id)
  const chips = showChips ? (ctx.chips.get(node.id) ?? []) : []
  const cls = ['learn-tree-move', node.mainLine ? 'mainline' : '', onLine ? 'on-line' : '', selected ? 'selected' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <>
      {isWhite ? <span className="learn-tree-num">{num}.</span> : forceNumber ? <span className="learn-tree-num">{num}…</span> : null}
      <button
        ref={selected ? ctx.selectedRef : undefined}
        type="button"
        className={cls}
        title={node.why || undefined}
        data-node-id={node.id}
        onClick={() => ctx.onSelectNode(node)}
      >
        {node.san}
        {node.nag ? <span className={`nag ${learnNagClass(node.nag)}`}>{node.nag}</span> : null}
      </button>
      {chips.map((l) => (
        <button
          key={l.id}
          type="button"
          className={`learn-chip cat-${l.category}${l.id === ctx.activeLineId ? ' active' : ''}`}
          title={t('{name} ({category}): click to follow this line', { name: l.name, category: LINE_CATEGORY_LABELS[l.category] ?? l.category })}
          data-line-id={l.id}
          onClick={() => ctx.onSelectLine(l, node)}
        >
          {l.name}
        </button>
      ))}{' '}
    </>
  )
}

/**
 * The line starting at `start` (shown only when `includeStart`; never the root), following first
 * children. At a branch the first child stays inline, its siblings become indented Variation
 * blocks, and the line continues in a new inline segment.
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
        <span className="learn-tree-moves" key={`seg-${main.id}`}>
          {segment}
        </span>,
      )
      blocks.push(
        <div className="learn-tree-branches" key={`alts-${main.id}`}>
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
      <span className="learn-tree-moves" key="seg-end">
        {segment}
      </span>,
    )
  }
  return <div className={`learn-tree-line${depth === 0 ? ' top' : ''}`}>{blocks}</div>
}

function Variation({ node, depth, ctx }: { node: OpeningNode; depth: number; ctx: Ctx }): JSX.Element {
  const holds = learnSubtreeHas(node, ctx.selectedId) || learnSubtreeHas(node, ctx.activeEndId)
  const [collapsed, setCollapsed] = useState(depth > ctx.autoCollapseDepth && !holds)
  // open when the selection / active line moves into this variation (adjust state during render)
  const [prevHolds, setPrevHolds] = useState(holds)
  if (prevHolds !== holds) {
    setPrevHolds(holds)
    if (holds) setCollapsed(false)
  }

  let collapsedLabel: ReactNode = null
  if (collapsed) {
    const through = learnLinesThroughSorted(node, ctx.lines)
    const first = through[0]
    collapsedLabel = (
      <>
        {first ? <span className={`learn-chip static cat-${first.category}`}>{first.name}</span> : null}
        {through.length > 1 ? <span className="learn-tree-hint">{t('+{n} more', { n: through.length - 1 })}</span> : null}
      </>
    )
  }

  return (
    <div className={`learn-tree-variation${node.mainLine ? ' mainline' : ''}`}>
      <button
        type="button"
        className={`learn-tree-toggle${collapsed ? ' collapsed' : ''}`}
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? t('Expand variation') : t('Collapse variation')}
        aria-expanded={!collapsed}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {collapsed ? (
        <span className="learn-tree-moves">
          <MoveToken node={node} ctx={ctx} forceNumber showChips={false} />
          {collapsedLabel}
        </span>
      ) : (
        <Line start={node} includeStart depth={depth} ctx={ctx} />
      )}
    </div>
  )
}

export function LearnTree({
  root,
  lines,
  selectedId,
  activeLineId,
  activeIds,
  chips,
  onSelectNode,
  onSelectLine,
  autoCollapseDepth,
}: LearnTreeProps): JSX.Element {
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const activeLine = activeLineId ? lines.find((l) => l.id === activeLineId) : undefined
  const activeEndId = activeLine ? activeLine.sans.join(' ') : null
  const ctx: Ctx = {
    lines,
    selectedId,
    activeLineId,
    activeEndId,
    activeIds,
    chips,
    onSelectNode,
    onSelectLine,
    autoCollapseDepth,
    selectedRef,
  }

  useEffect(() => {
    // after any variation holding the selection has expanded
    const id = requestAnimationFrame(() => scrollIntoViewWithin(selectedRef.current, containerRef.current, 32))
    return () => cancelAnimationFrame(id)
  }, [selectedId])

  if (root.children.length === 0) {
    return <div className="learn-tree learn-empty-note">{t('This opening has no moves.')}</div>
  }
  return (
    <div className="learn-tree" ref={containerRef}>
      <Line start={root} includeStart={false} depth={0} ctx={ctx} />
    </div>
  )
}

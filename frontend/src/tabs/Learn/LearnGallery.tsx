/**
 * LearnGallery: one card per opening (name, side badge, ECO, line count, one-line summary, a
 * thumbnail of the opening's defining position), primary openings first.
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import * as api from '../../api/client'
import { LINE_CATEGORY_LABELS, type LineCategory, type OpeningSummary, type Side } from '../../api/types'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Spinner'
import { formatSanPath } from '../../lib/chess'
import { t, tn } from '../../lib/i18n'
import { LearnMiniBoard } from './LearnMiniBoard'
import { learnCategoryRank, learnFirstSentence, learnIsGambit, learnPreview, learnSortOpenings } from './learnUtils'

export interface LearnGalleryProps {
  onOpen: (openingId: string) => void
}

type SideFilter = 'all' | Side

function LearnCard({ o, onOpen }: { o: OpeningSummary; onOpen: (id: string) => void }): JSX.Element {
  const preview = useMemo(() => learnPreview(o), [o])
  const cats = useMemo(
    () =>
      (Object.entries(o.categoriesCount) as [LineCategory, number][])
        .filter(([, n]) => n > 0)
        .sort((a, b) => learnCategoryRank(a[0]) - learnCategoryRank(b[0])),
    [o],
  )
  return (
    <button type="button" className="card clickable learn-card" onClick={() => onOpen(o.id)} data-opening-id={o.id}>
      <div className="learn-card-top">
        <LearnMiniBoard fen={preview.fen} orientation={o.side} lastMove={preview.lastMove} size={104} />
        <div className="learn-card-head">
          <div className="learn-card-name">{o.name}</div>
          <div className="row wrap gap-4">
            <span className={`badge badge-${o.side}`}>{o.side === 'white' ? t('White') : t('Black')}</span>
            {o.eco ? <span className="badge badge-eco">{o.eco}</span> : null}
            {learnIsGambit(o.name) ? <span className="badge badge-yellow">{t('Gambit')}</span> : null}
          </div>
          <div className="learn-card-count">
            <Icon name="book" size={14} /> {tn(o.lineCount, '{n} line', '{n} lines')}
          </div>
          {preview.sans.length > 0 ? <div className="learn-card-moves mono truncate">{formatSanPath(preview.sans)}</div> : null}
        </div>
      </div>
      <p className="learn-card-summary">{learnFirstSentence(o.summary)}</p>
      {cats.length > 0 ? (
        <div className="learn-card-cats">
          {cats.map(([cat, n]) => (
            <span key={cat} className={`learn-cat-pill cat-${cat}`}>
              {n} {(LINE_CATEGORY_LABELS[cat] ?? cat)}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  )
}

export function LearnGallery({ onOpen }: LearnGalleryProps): JSX.Element {
  const [openings, setOpenings] = useState<OpeningSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [side, setSide] = useState<SideFilter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const ctrl = new AbortController()
    api
      .listOpenings(ctrl.signal)
      .then((list) => {
        setOpenings(learnSortOpenings(list))
        setError(null)
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => ctrl.abort()
  }, [reload])

  const shown = useMemo(() => {
    if (!openings) return []
    const q = query.trim().toLowerCase()
    return openings.filter(
      (o) =>
        (side === 'all' || o.side === side) &&
        (q === '' || `${o.name} ${o.eco} ${o.family}`.toLowerCase().includes(q)),
    )
  }, [openings, side, query])

  const counts = useMemo(() => {
    const c = { all: openings?.length ?? 0, white: 0, black: 0 }
    openings?.forEach((o) => {
      c[o.side] += 1
    })
    return c
  }, [openings])

  return (
    <div className="learn-gallery">
      <div className="learn-gallery-header">
        <div>
          <h1 className="learn-title">
            <Icon name="learn" size={24} /> {t('Learn')}
          </h1>
          <p className="muted learn-subtitle">
            {t(
              'Pick an opening to browse it move by move: the tree of every line, why each move is played, and the plans and traps behind it.',
            )}
          </p>
        </div>
        <div className="row wrap">
          <div className="btn-group" role="group" aria-label={t('Filter by side')}>
            {(['all', 'white', 'black'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={`btn btn-sm${side === s ? ' active' : ''}`}
                onClick={() => setSide(s)}
                aria-pressed={side === s}
              >
                {s === 'all' ? t('All') : s === 'white' ? t('As White') : t('As Black')} <span className="learn-filter-count">{counts[s]}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            className="learn-search"
            placeholder={t('Search openings, ECO…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('Search openings')}
          />
        </div>
      </div>

      {error ? (
        <EmptyState
          icon="warning"
          title={t('Could not load the openings')}
          description={error}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setReload((n) => n + 1)}>
              <Icon name="refresh" size={16} /> {t('Retry')}
            </button>
          }
        />
      ) : openings === null ? (
        <div className="learn-loading">
          <Spinner size={28} />
          <span className="muted">{t('Loading openings…')}</span>
        </div>
      ) : openings.length === 0 ? (
        <EmptyState
          icon="book"
          title={t('No openings yet')}
          description={t('Add repertoire files to data/openings/*.json and they will show up here.')}
        />
      ) : shown.length === 0 ? (
        <EmptyState icon="search" title={t('No opening matches')} description={t('Try another search or side filter.')} />
      ) : (
        <div className="learn-grid">
          {shown.map((o) => (
            <LearnCard key={o.id} o={o} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

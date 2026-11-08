/**
 * TypeScript mirrors of every JSON contract in ARCHITECTURE.md.
 * Keep this file in sync with backend/app/schemas.py.
 *
 * Conventions:
 *  - Scores are ALWAYS from White's point of view on the wire.
 *  - Moves travel as UCI ("e2e4"); SAN is included for display.
 */

// ---------------------------------------------------------------- shared

export type Side = 'white' | 'black'

/** Engine score, White POV. `cp` in centipawns, `mate` in moves (negative = White gets mated). */
export type Score = { cp: number } | { mate: number }

export interface EngineLine {
  multipv: number
  score: Score
  depth: number
  /** Principal variation in SAN. */
  pv: string[]
  /** Same variation in UCI. */
  pvUci: string[]
}

// ---------------------------------------------------------------- openings

export type LineCategory =
  | 'main'
  | 'accepted'
  | 'declined'
  | 'sideline'
  | 'trap'
  | 'transposition'
  | 'alternative'

export const LINE_CATEGORIES: readonly LineCategory[] = [
  'main',
  'accepted',
  'declined',
  'alternative',
  'sideline',
  'trap',
  'transposition',
]

/** Human-readable group names used by the Learn "Lines" panel. */
export const LINE_CATEGORY_LABELS: Record<LineCategory, string> = {
  main: 'Main',
  accepted: 'Accepted',
  declined: 'Declined',
  alternative: 'Alternatives',
  sideline: 'Sidelines',
  trap: 'Traps',
  transposition: 'Transpositions',
}

/** NAG annotation glyphs allowed in the data. */
export type Nag = '' | '!' | '!?' | '?!' | '?' | '??' | '!!'

export interface OpeningNode {
  /** Stable: the SAN path joined by " " (e.g. "e4 Nf6 Nc3"); "" for the root. */
  id: string
  /** Move that led here ("" for root). */
  san: string
  /** "e2e4" ("" for root). */
  uci: string
  /** Position AFTER the move. */
  fen: string
  /** 1 for 1.e4; 0 for the root. */
  ply: number
  /** Best non-empty explanation among lines through this node. */
  why: string
  /** "!?" etc, first non-empty. */
  nag: string
  /** Ids of lines passing through this node. */
  lineIds: string[]
  /** Node lies on a category "main" line. */
  mainLine: boolean
  /** Union of the categories of lines through this node. */
  categories: string[]
  /** Ordered: main-line child first, then by (number of lines desc, san). */
  children: OpeningNode[]
}

export interface OpeningSummary {
  id: string
  name: string
  /** The side the student plays. */
  side: Side
  eco: string
  family: string
  summary: string
  lineCount: number
  mainLineSans: string[]
  categoriesCount: Partial<Record<LineCategory, number>>
}

export interface LineMeta {
  id: string
  name: string
  category: LineCategory
  description: string
  evaluation: string
  sans: string[]
  finalFen: string
}

export interface OpeningFull extends OpeningSummary {
  keyIdeas: string[]
  typicalPlans: string[]
  commonMistakes: string[]
  sources: string[]
  lines: LineMeta[]
  tree: OpeningNode
}

/* Raw repertoire file schema (data/openings/<id>.json, see tools/validate_opening.py).
   The backend consumes these; the frontend only uses them in the dev playground. */
export interface OpeningFileMove {
  san: string
  why: string
  nag?: string
}
export interface OpeningFileLine {
  id: string
  name: string
  category: LineCategory
  description: string
  evaluation?: string
  moves: OpeningFileMove[]
}
export interface OpeningFile {
  id: string
  name: string
  side: Side
  eco?: string
  family?: string
  summary: string
  keyIdeas: string[]
  typicalPlans?: string[]
  commonMistakes?: string[]
  sources?: string[]
  lines: OpeningFileLine[]
}

// ---------------------------------------------------------------- quiz

export type QuizMode = 'positions' | 'traps'

export interface QuizAnswer {
  san: string
  uci: string
  why: string
  lineIds: string[]
  lineNames: string[]
}

export interface QuizItem {
  /** Node id of the position (SAN path before the answer). */
  id: string
  openingId: string
  openingName: string
  /** Position where the student is to move. */
  fen: string
  /** Moves so far. */
  sanPath: string[]
  /** All acceptable answers. */
  answers: QuizAnswer[]
  kind: 'position' | 'trap'
  lastOpponentMove?: { san: string; why: string }
}

// ---------------------------------------------------------------- analysis

export interface AnalyzeRequest {
  fen: string
  /** 1-5, default 3. */
  multipv?: number
  /** Default 18. */
  depth?: number
  movetime_ms?: number
}

export interface AnalyzeResponse {
  fen: string
  depth: number
  lines: EngineLine[]
}

/** One streamed message from /ws/analyze. */
export interface AnalysisInfo {
  type: 'info'
  fen: string
  depth: number
  seldepth: number
  nodes: number
  nps: number
  lines: EngineLine[]
}

/** Client -> server messages on /ws/analyze. */
export type AnalysisCommand = { fen: string; multipv: number } | { stop: true }

// ---------------------------------------------------------------- bot

export type BotKind = 'stockfish' | 'maia' | 'panicfish'

export type VariantId = 'standard' | 'chess960' | 'crazyhouse' | 'kingofthehill' | '3check' | 'antichess' | 'atomic' | 'horde' | 'racingkings'

export interface BotMoveRequest {
  fen: string
  /** Stockfish: 400-3190. Maia: 1100, 1200, ..., 1900. Panicfish: what it has left, 3600 down to 0. */
  elo: number
  /** Default 800. Maia ignores it. */
  movetime_ms?: number
  /** Default "stockfish". */
  bot?: BotKind
  /** Default "standard". */
  variant?: VariantId
  /** Maia: UCI moves played from `start_fen`, oldest first. */
  moves?: string[]
  /** Maia: root FEN of `moves` (default: the standard start). */
  start_fen?: string
}

export interface BotStrength {
  mode: 'uci_elo' | 'skill' | 'maia' | 'full' | 'random'
  skill?: number
  elo: number
}

export interface BotMoveResponse {
  uci: string
  san: string
  fen_after: string
  eval: Score | null
  strength: BotStrength
}

// ---------------------------------------------------------------- pgn

export interface PgnParseRequest {
  pgn: string
}

export interface PgnParsedMove {
  san: string
  uci: string
  /** Position AFTER the move. */
  fen: string
}

export interface PgnParseResponse {
  headers: Record<string, string>
  moves: PgnParsedMove[]
  startFen: string
}

// ---------------------------------------------------------------- review

export type Classification =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'miss'

export const CLASSIFICATIONS: readonly Classification[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'blunder',
  'miss',
]

export interface Players {
  white: string
  black: string
}

export interface ReviewRequest {
  /** UCI or SAN from the initial position (or from startFen). */
  moves: string[]
  startFen?: string
  /** 12-24, default 16. */
  depth?: number
  players?: Players
}

export interface ReviewMove {
  /** 1-based. */
  ply: number
  san: string
  uci: string
  fenBefore: string
  fenAfter: string
  color: Side
  /** Best-play eval of fenBefore (White POV). */
  evalBefore: Score
  /** Eval of fenAfter (White POV). */
  evalAfter: Score
  /** Engine's best move in fenBefore. */
  bestMove: { san: string; uci: string; pv: string[] }
  /** Engine PV after the played move (SAN). */
  playedPv: string[]
  /** 0..100 from the MOVER's point of view. */
  winPctBefore: number
  winPctAfter: number
  /** Centipawns lost by the mover (>= 0). */
  cpLoss: number
  classification: Classification
  /** If the move is in our opening data, its "why". */
  bookWhy?: string
  /** Opening name from our data. */
  bookOpening?: string
  /** Filled by /api/explain. */
  explanation?: string
}

export type ClassificationCounts = Record<Classification, number>

export interface ReviewResult {
  moves: ReviewMove[]
  /** 0..100 per side. */
  accuracy: { white: number; black: number }
  counts: { white: ClassificationCounts; black: ClassificationCounts }
  opening?: { id: string; name: string; lastBookPly: number }
  depth: number
  engine: string
}

export type ReviewStatus = 'queued' | 'running' | 'done' | 'error'

export interface ReviewJob {
  jobId: string
  status: ReviewStatus
  /** 0..1 */
  progress: number
  message?: string
  result?: ReviewResult
}

export interface ReviewStartResponse {
  jobId: string
}

// ---------------------------------------------------------------- explain (Ollama)

export interface ExplainRequest {
  jobId: string
  ply: number
  model?: string
}

export interface ExplainResponse {
  text: string
}

/** Streamed messages from /ws/explain. */
export type ExplainEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------- coach (single move, Learn practice)

/** A repertoire move and its explanation. `san` may also be UCI; `uci` is optional. */
export interface BookMoveNote {
  san: string
  why: string
  uci?: string
  /** The repertoire's own annotation of the move ("!", "!?", "?!", "?", "??"), if any. */
  nag?: string
}

export interface CoachContext {
  openingName?: string
  lineName?: string
  /** The side the student plays in this repertoire (default: the side that moved). */
  studentSide?: Side
  /** Repertoire moves in the position BEFORE the move (may be empty). Max 40. */
  bookMoves?: BookMoveNote[]
  /** Repertoire replies AFTER the move (what the other side plays next). Max 40. */
  replyBookMoves?: BookMoveNote[]
}

export interface CoachRequest {
  /** Echoed in every WS reply (POST ignores it). */
  requestId: string
  /** Position BEFORE the move. */
  fen: string
  /** The move played (UCI; SAN is accepted too). Must be legal in `fen`. */
  uci: string
  /** Default true: also stream an Ollama explanation. */
  explain?: boolean
  /** Ollama model; omitted = backend default. */
  model?: string
  /** 8-22, default 14. */
  depth?: number
  context?: CoachContext
}

export interface CoachMove {
  san: string
  uci: string
  fenBefore: string
  fenAfter: string
  color: Side
  /** White POV, best play in fenBefore. */
  evalBefore: Score
  /** White POV. */
  evalAfter: Score
  bestMove: { san: string; uci: string; pv: string[] }
  playedPv: string[]
  /** 0..100 from the MOVER's point of view. */
  winPctBefore: number
  winPctAfter: number
  cpLoss: number
  /** Review rules; "book" when the move is in context.bookMoves; never "miss". */
  classification: Classification
  inBook: boolean
  /** When NOT inBook and bookMoves is non-empty: the first repertoire move (what to play instead). */
  bookMove?: BookMoveNote
}

/** POST /api/coach/move response. Optional fields are omitted, not null. */
export interface CoachResponse {
  move: CoachMove
  /** "" when explain=false or when Ollama failed (then `coachError` is set). */
  text: string
  coachError?: string
}

/** Streamed messages from /ws/coach (every one carries the request's id). */
export type CoachEvent =
  | { type: 'analysis'; requestId: string; move: CoachMove }
  | { type: 'token'; requestId: string; text: string }
  | { type: 'done'; requestId: string; text: string }
  | { type: 'error'; requestId: string; stage: 'analysis' | 'explain'; message: string }

export interface OllamaModel {
  name: string
  size: number
  family: string
  parameter_size: string
}

export interface OllamaModelsResponse {
  models: OllamaModel[]
  default: string
}

// ---------------------------------------------------------------- system

export interface Health {
  ok: boolean
  stockfish: { name: string; path: string }
  ollama: { ok: boolean; models: string[] }
  openings: number
  /** `ratings`: the ratings whose weight file exists; `path`: lc0. Only looks at files, never starts lc0. */
  /** Absent from a backend older than this frontend (a restart fixes that). */
  maia?: { available: boolean; ratings: number[]; path: string }
  /** Fairy-Stockfish, which plays the variants Stockfish 19 cannot. Only looks at the file. */
  fairy?: { available: boolean; path: string }
}

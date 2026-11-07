#!/usr/bin/env python
"""Validate (and optionally normalize) one opening JSON file.

Usage:
  python tools/validate_opening.py data/openings/<id>.json [--fix] [--engine]

  --fix     rewrite the file with canonical SAN (e.g. 0-0 -> O-O, adds +/#) and
            stable 2-space indentation.
  --engine  also run a quick Stockfish sanity check (depth 12) on every move of
            the repertoire side and flag moves that lose >= 150 centipawns
            versus the engine's best move. Opponent moves are also flagged when
            they lose >= 300 cp and the line is not category "trap"/"declined".

Exit code 0 = no errors (warnings allowed), 1 = errors.

SCHEMA (all SAN moves start from the normal initial position):
{
  "id": "alien-gambit",                 # must equal the file name
  "name": "Alien Gambit",
  "side": "white" | "black",            # which side the STUDENT plays
  "eco": "B02",                         # optional
  "family": "1.e4 Nf6 Alekhine's Defense",   # optional, one line
  "summary": "2-5 sentence overview of the opening and its spirit.",
  "keyIdeas": ["short bullet", ...],    # 3-8 items
  "typicalPlans": ["..."],              # optional
  "commonMistakes": ["..."],            # optional
  "sources": ["https://..."],           # optional but encouraged
  "lines": [
    {
      "id": "main",                     # unique within the file, kebab-case
      "name": "Main line: 4...fxe6 5.d4",
      "category": "main" | "accepted" | "declined" | "sideline" | "trap" | "transposition" | "alternative",
      "description": "1-3 sentences: when this arises and what the plan is.",
      "evaluation": "White is slightly better (+0.4)",   # optional free text
      "moves": [
        {"san": "e4", "why": "Takes space in the centre and opens lines for the queen and bishop.", "nag": "" },
        ...
      ]
    }
  ]
}
Rules enforced:
  * every move is legal from the previous position
  * each distinct position reached (tree node) has at least one non-empty "why"
    somewhere in the file (so the UI can always explain the move)
  * at least one line has category "main"; line ids unique; no duplicate move
    sequences; a line that is a strict prefix of another line is a warning
  * each line has >= 6 plies; > 44 plies is a warning
"""
import sys, json, os, re
import chess

CATEGORIES = {"main", "accepted", "declined", "sideline", "trap", "transposition", "alternative"}
NAGS = {"", "!", "!?", "?!", "?", "??", "!!"}
REQUIRED_TOP = ["id", "name", "side", "summary", "keyIdeas", "lines"]


def main():
    argv = sys.argv[1:]
    fix = "--fix" in argv
    use_engine = "--engine" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        print(__doc__)
        sys.exit(2)
    path = paths[0]
    errors, warnings = [], []

    with open(path, encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"ERROR: invalid JSON: {e}")
            sys.exit(1)

    for k in REQUIRED_TOP:
        if k not in data:
            errors.append(f"missing top-level field '{k}'")
    if errors:
        report(errors, warnings)
        sys.exit(1)

    stem = os.path.splitext(os.path.basename(path))[0]
    if data["id"] != stem:
        errors.append(f"id '{data['id']}' must equal file name '{stem}'")
    if data["side"] not in ("white", "black"):
        errors.append("side must be 'white' or 'black'")
    if not isinstance(data["keyIdeas"], list) or len(data["keyIdeas"]) < 3:
        errors.append("keyIdeas must be a list with at least 3 items")
    if not isinstance(data["summary"], str) or len(data["summary"]) < 80:
        errors.append("summary must be a string of at least 80 characters")
    lines = data["lines"]
    if not isinstance(lines, list) or not lines:
        errors.append("lines must be a non-empty list")
        report(errors, warnings)
        sys.exit(1)

    student_white = data["side"] == "white"
    ids = set()
    seqs = {}
    node_whys = {}   # tuple(san...) -> list of whys
    node_lines = {}  # tuple(san...) -> line ids reaching it
    mains = [ln for ln in lines if ln.get("category") == "main"]
    if not mains:
        errors.append("at least one line must have category 'main'")

    for li, ln in enumerate(lines):
        lid = ln.get("id", f"<line {li}>")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", str(lid)):
            errors.append(f"line {li}: id '{lid}' must be kebab-case (a-z, 0-9, '-')")
        if lid in ids:
            errors.append(f"line '{lid}': duplicate id")
        ids.add(lid)
        for k in ("name", "category", "description", "moves"):
            if k not in ln:
                errors.append(f"line '{lid}': missing field '{k}'")
        if ln.get("category") not in CATEGORIES:
            errors.append(f"line '{lid}': category '{ln.get('category')}' not in {sorted(CATEGORIES)}")
        moves = ln.get("moves") or []
        if not isinstance(moves, list) or len(moves) < 6:
            n = len(moves) if isinstance(moves, list) else "?"
            errors.append(f"line '{lid}': needs at least 6 plies (has {n})")
            continue
        if len(moves) > 44:
            warnings.append(f"line '{lid}': {len(moves)} plies is long; consider splitting")

        board = chess.Board()
        path_sans = []
        ok = True
        for pi, mv in enumerate(moves):
            if not isinstance(mv, dict) or "san" not in mv:
                errors.append(f"line '{lid}' ply {pi+1}: each move must be an object with 'san' and 'why'")
                ok = False
                break
            san = str(mv["san"]).strip().replace("0-0-0", "O-O-O").replace("0-0", "O-O")
            try:
                move = board.parse_san(san)
            except ValueError:
                legal = sorted(board.san(m) for m in board.legal_moves)
                mvnum = move_number_prefix(pi)
                errors.append(
                    f"line '{lid}' ply {pi+1} ({mvnum}{san}): ILLEGAL/unparseable in position "
                    f"{board.fen()} after '{' '.join(path_sans)}'. Legal moves: {' '.join(legal)}")
                ok = False
                break
            canon = board.san(move)
            if canon != mv["san"]:
                if fix:
                    mv["san"] = canon
                else:
                    warnings.append(f"line '{lid}' ply {pi+1}: SAN '{mv['san']}' will be normalized to '{canon}' with --fix")
            nag = str(mv.get("nag", "") or "")
            if nag not in NAGS:
                errors.append(f"line '{lid}' ply {pi+1}: nag '{nag}' not in {sorted(NAGS)}")
            why = str(mv.get("why", "") or "").strip()
            if fix:
                mv["why"] = why
            board.push(move)
            path_sans.append(canon)
            key = tuple(path_sans)
            node_whys.setdefault(key, []).append(why)
            node_lines.setdefault(key, []).append(lid)
        if not ok:
            continue
        seq = tuple(path_sans)
        if seq in seqs:
            errors.append(f"line '{lid}': identical move sequence to line '{seqs[seq]}'")
        seqs[seq] = lid

    # strict-prefix check
    seq_list = list(seqs.items())
    for s1, id1 in seq_list:
        for s2, id2 in seq_list:
            if s1 != s2 and len(s1) < len(s2) and s2[:len(s1)] == s1:
                warnings.append(f"line '{id1}' is a strict prefix of line '{id2}' (merge or extend it)")
                break

    # every node explained at least once
    missing = []
    for key, whys in node_whys.items():
        if not any(w for w in whys):
            ply = len(key)
            mvnum = move_number_prefix(ply - 1)
            missing.append(f"{mvnum}{key[-1]} (after: {' '.join(key[:-1])}) in line(s) {sorted(set(node_lines[key]))}")
        else:
            best = max((w for w in whys if w), key=len)
            if len(best) < 25:
                warnings.append(f"node '{' '.join(key)}': explanation very short ('{best}')")
    for m in missing[:60]:
        errors.append(f"move has no 'why' anywhere in file: {m}")
    if len(missing) > 60:
        errors.append(f"... and {len(missing)-60} more unexplained moves")

    if use_engine and not errors:
        engine_check(lines, student_white, warnings)

    if fix and not errors:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"(normalized and saved {path})")

    report(errors, warnings)
    total_plies = sum(len(ln.get("moves", [])) for ln in lines)
    print(f"SUMMARY: {len(lines)} lines, {total_plies} plies, {len(node_whys)} distinct positions, "
          f"{len(errors)} errors, {len(warnings)} warnings")
    sys.exit(1 if errors else 0)


def move_number_prefix(ply_index):
    """ply_index 0 -> '1.', 1 -> '1...', 2 -> '2.' ..."""
    n = ply_index // 2 + 1
    return f"{n}." if ply_index % 2 == 0 else f"{n}..."


def engine_check(lines, student_white, warnings):
    import chess.engine
    here = os.path.dirname(os.path.abspath(__file__))
    exe = os.path.join(here, "..", "engines", "stockfish19.exe")
    if not os.path.exists(exe):
        warnings.append("engine check skipped: engines/stockfish19.exe not found")
        return
    eng = chess.engine.SimpleEngine.popen_uci(exe)
    eng.configure({"Threads": 2, "Hash": 64})
    limit = chess.engine.Limit(depth=12)
    cache = {}

    def score(board):
        key = board.fen()
        if key not in cache:
            info = eng.analyse(board, limit)
            cache[key] = info["score"].white().score(mate_score=10000)
        return cache[key]

    try:
        for ln in lines:
            board = chess.Board()
            cat = ln.get("category")
            for pi, mv in enumerate(ln["moves"]):
                before = score(board)
                move = board.parse_san(mv["san"])
                mover_white = board.turn == chess.WHITE
                board.push(move)
                after = score(board)
                # loss from the mover's perspective (positive = mover lost ground)
                loss = (before - after) if mover_white else (after - before)
                is_student = (mover_white == student_white)
                mvnum = f"{move_number_prefix(pi)}{mv['san']}"
                if is_student and loss >= 150:
                    warnings.append(
                        f"ENGINE: line '{ln['id']}' {mvnum} loses ~{loss}cp vs best "
                        f"(eval {before/100:+.2f} -> {after/100:+.2f}). Check this move; if it is a "
                        f"deliberate gambit/trap, say so in 'why'.")
                if (not is_student) and loss >= 300 and cat not in ("trap", "declined"):
                    warnings.append(
                        f"ENGINE: line '{ln['id']}' opponent move {mvnum} is a blunder (~{loss}cp). "
                        f"Fine for a 'trap' line; otherwise prefer the opponent's best replies.")
    finally:
        eng.quit()


def report(errors, warnings):
    for w in warnings:
        print(f"WARN: {w}")
    for e in errors:
        print(f"ERROR: {e}")
    if not errors:
        print("OK: no errors")


if __name__ == "__main__":
    main()

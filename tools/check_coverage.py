#!/usr/bin/env python
"""Find plausible opponent replies that an opening file does not cover.

Usage:
  python tools/check_coverage.py data/openings/<id>.json --min-ply N [--max-ply N]
         [--engine] [--multipv 4] [--depth 16] [--window 70]
         [--explorer] [--min-share 0.10] [--min-games 300] [--ratings 1400,1600,1800,2000]
         [--json]

For every position in the file's move tree where it is the OPPONENT's turn and
min-ply <= ply < max-ply, report replies that the file does not continue with.

Two sources (default: --engine; both can be combined):

  --engine    Stockfish 19 MultiPV. A reply is "plausible" when its evaluation is
              within --window centipawns (default 70) of the best reply at --depth
              (default 16). Catches the opponent's objectively good options.
  --explorer  Lichess opening explorer (human popularity). Needs an API token in
              the LICHESS_TOKEN environment variable or in <repo>/.lichess_token
              (the public endpoint returns 401 without one, as of Nov 2026). A
              reply is reported when it is played in >= --min-share of games.

  --min-ply   first ply (0-based count of moves already played) to check.
              Use the ply where the opening is actually entered, e.g. Italian
              Game (after 1.e4 e5 2.Nf3 Nc6 3.Bc4) -> 5; Alien Gambit (after
              1.e4 Nf6) -> 2; Caro-Kann as Black (after 1.e4 c6) -> 2.
  --max-ply   stop checking at this ply (default 12 = through Black's 6th move).
  --json      print machine-readable JSON instead of text.

Only positions that already have at least one continuation in the file are
checked (leaves are not). Results of explorer calls are cached under
data/_cache/explorer.
"""
import sys, json, os, time, hashlib, urllib.request, urllib.error
import chess
import chess.engine

API = "https://explorer.lichess.ovh/lichess"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "..", "data", "_cache", "explorer")
ENGINE = os.path.join(HERE, "..", "engines", "stockfish19.exe")


def arg(name, default):
    argv = sys.argv
    if name in argv:
        i = argv.index(name)
        return argv[i + 1]
    return default


def fetch_explorer(uci_moves, ratings, token, speeds="blitz,rapid,classical", top=16):
    url = (f"{API}?variant=standard&speeds={speeds}&ratings={ratings}"
           f"&play={','.join(uci_moves)}&moves={top}&topGames=0&recentGames=0")
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = hashlib.sha1(url.encode()).hexdigest()
    cpath = os.path.join(CACHE_DIR, key + ".json")
    if os.path.exists(cpath):
        with open(cpath, encoding="utf-8") as f:
            return json.load(f)
    headers = {"User-Agent": "chess-openings-trainer/1.0 (local study app)"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            with open(cpath, "w", encoding="utf-8") as f:
                json.dump(data, f)
            time.sleep(0.7)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("(rate limited, sleeping 61s)", file=sys.stderr)
                time.sleep(61)
                continue
            if e.code == 401:
                raise RuntimeError("401 Unauthorized: set LICHESS_TOKEN to use --explorer")
            raise
    raise RuntimeError("explorer fetch failed repeatedly")


def load_token():
    """LICHESS_TOKEN env var, else the contents of <repo>/.lichess_token (git-ignored)."""
    tok = os.environ.get("LICHESS_TOKEN", "").strip()
    if tok:
        return tok
    path = os.path.join(HERE, "..", ".lichess_token")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    return ""


def build_tree(data):
    """path tuple of SAN -> {"children": set(SAN), "fen": str, "uci": [...]}"""
    nodes = {}
    for ln in data["lines"]:
        board = chess.Board()
        sans, ucis = [], []
        node = nodes.setdefault((), {"children": set(), "uci": [], "fen": board.fen()})
        for mv in ln["moves"]:
            move = board.parse_san(mv["san"])
            san = board.san(move)
            node["children"].add(san)
            board.push(move)
            sans.append(san)
            ucis.append(move.uci())
            node = nodes.setdefault(tuple(sans), {"children": set(), "uci": list(ucis), "fen": board.fen()})
    return nodes


def main():
    paths = [a for a in sys.argv[1:] if not a.startswith("--") and a.endswith(".json")]
    if not paths or "--min-ply" not in sys.argv:
        print(__doc__)
        sys.exit(2)
    path = paths[0]
    min_ply = int(arg("--min-ply", 4))
    max_ply = int(arg("--max-ply", 12))
    use_explorer = "--explorer" in sys.argv
    use_engine = "--engine" in sys.argv or not use_explorer
    multipv = int(arg("--multipv", 4))
    depth = int(arg("--depth", 16))
    window = int(arg("--window", 70))
    min_share = float(arg("--min-share", 0.10))
    min_games = int(arg("--min-games", 300))
    ratings = arg("--ratings", "1400,1600,1800,2000")
    token = load_token()
    as_json = "--json" in sys.argv

    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    student_white = data["side"] == "white"
    nodes = build_tree(data)

    todo = []
    for key, node in sorted(nodes.items(), key=lambda kv: (len(kv[0]), kv[0])):
        ply = len(key)
        if ply < min_ply or ply >= max_ply or not node["children"]:
            continue
        white_to_move = (ply % 2 == 0)
        if (white_to_move != student_white):
            todo.append((key, node))

    gaps = []
    engine = None
    if use_engine and todo:
        if not os.path.exists(ENGINE):
            print(f"ERROR: engine not found at {ENGINE}", file=sys.stderr)
            sys.exit(1)
        engine = chess.engine.SimpleEngine.popen_uci(ENGINE)
        try:
            engine.configure({"Threads": 4, "Hash": 256})  # MultiPV is passed per analyse() call
        except Exception:
            engine.quit()
            raise

    try:
        for key, node in todo:
            entry = {"after": " ".join(key), "ply": len(key), "covered": sorted(node["children"]),
                     "engineMissing": [], "explorerMissing": [], "openingName": None}
            board = chess.Board(node["fen"])
            if engine is not None:
                infos = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=multipv)
                scored = []
                for info in infos:
                    if "pv" not in info or not info["pv"]:
                        continue
                    mv = info["pv"][0]
                    cp = info["score"].pov(board.turn).score(mate_score=10000)
                    scored.append((board.san(mv), cp))
                if scored:
                    best = max(cp for _, cp in scored)
                    for san, cp in scored:
                        if san not in node["children"] and best - cp <= window:
                            entry["engineMissing"].append({"san": san, "cpBehindBest": best - cp,
                                                           "eval": round(cp / 100, 2)})
            if use_explorer:
                try:
                    ex = fetch_explorer(node["uci"], ratings, token)
                    total = ex.get("white", 0) + ex.get("draws", 0) + ex.get("black", 0)
                    entry["openingName"] = (ex.get("opening") or {}).get("name")
                    entry["games"] = total
                    if total >= min_games:
                        for m in ex.get("moves", []):
                            n = m["white"] + m["draws"] + m["black"]
                            share = n / total
                            if m["san"] not in node["children"] and share >= min_share:
                                entry["explorerMissing"].append({"san": m["san"], "share": round(share, 3), "games": n})
                except Exception as e:
                    print(f"WARN: explorer failed for '{entry['after']}': {e}", file=sys.stderr)
                    if "401" in str(e):
                        use_explorer = False  # stop hammering the endpoint
            if entry["engineMissing"] or entry["explorerMissing"]:
                gaps.append(entry)
    finally:
        if engine is not None:
            engine.quit()

    if as_json:
        print(json.dumps({"checked": len(todo), "gaps": gaps}, indent=2))
        return
    print(f"Checked {len(todo)} opponent-to-move positions (plies {min_ply}-{max_ply - 1})"
          + (f"; engine depth {depth}, MultiPV {multipv}, window {window}cp" if use_engine else "")
          + (f"; explorer ratings {ratings}, min share {min_share:.0%}" if use_explorer else "") + ".")
    if not gaps:
        print("OK: no coverage gaps.")
    for g in gaps:
        parts = []
        if g["engineMissing"]:
            parts.append("engine likes: " + ", ".join(
                f"{m['san']} ({m['eval']:+.2f}, {m['cpBehindBest']}cp behind best)" for m in g["engineMissing"]))
        if g["explorerMissing"]:
            parts.append("humans play: " + ", ".join(f"{m['san']} ({m['share']:.0%})" for m in g["explorerMissing"]))
        print(f"GAP after '{g['after']}' (covered: {g['covered']}): " + "; ".join(parts))
    print(f"SUMMARY: {len(gaps)} positions with uncovered plausible replies")


if __name__ == "__main__":
    main()

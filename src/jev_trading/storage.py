import json
import sqlite3
from pathlib import Path

from .contracts import ContextSnapshot, DecisionSignal, canonical


class BusyRun(Exception):
    pass


class DecisionStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=10)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(
                id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(id),
                request TEXT NOT NULL, state TEXT NOT NULL, signal TEXT, raw_response TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        """)

    def claim(self, run_id: str, context: ContextSnapshot, request: dict) -> DecisionSignal | None:
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO contexts VALUES (?, ?)",
                            (context.context_id, context.model_dump_json()))
            cursor = self.db.execute(
                "INSERT OR IGNORE INTO runs(id,context_id,request,state) VALUES (?,?,?,'running')",
                (run_id, context.context_id, canonical(request)),
            )
            if cursor.rowcount:
                return None
            row = self.db.execute("SELECT signal FROM runs WHERE id=?", (run_id,)).fetchone()
            if row[0] is None:
                raise BusyRun("Decision already running or interrupted; inspect it, then use an explicit retry token")
            return DecisionSignal.model_validate_json(row[0])

    def finish(self, signal: DecisionSignal, raw: dict | None):
        raw_text = json.dumps(raw, ensure_ascii=False) if raw is not None else None
        with self.db:
            self.db.execute("UPDATE runs SET state='finished',signal=?,raw_response=? WHERE id=?",
                            (signal.model_dump_json(), raw_text, signal.decision_id))

    def inspect(self, decision_id: str) -> dict:
        row = self.db.execute(
            "SELECT r.state,r.request,r.signal,r.raw_response,c.body FROM runs r "
            "JOIN contexts c ON r.context_id=c.id WHERE r.id=?", (decision_id,),
        ).fetchone()
        if row is None:
            raise KeyError(decision_id)
        return dict(zip(("state", "request", "signal", "raw_response", "context"),
                        (row[0], *(json.loads(v) if v else None for v in row[1:]))))

    def close(self):
        self.db.close()

#!/usr/bin/env python3
"""Inspect an infrasys time series SQLite metadata DB.

Input can be:
- direct path to `time_series_metadata.db`
- path to a `*_time_series/` directory containing that DB

Examples
--------
uvx --from python python skills/infrasys/scripts/inspect_time_series_db.py ./system_time_series/time_series_metadata.db
uvx --from python python skills/infrasys/scripts/inspect_time_series_db.py ./system_time_series --sample 3
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

DB_FILENAME = "time_series_metadata.db"


def resolve_db_path(path: Path) -> Path:
    p = path.expanduser()
    if p.is_dir():
        p = p / DB_FILENAME
    return p


def table_names(con: sqlite3.Connection) -> list[str]:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def print_counts(con: sqlite3.Connection, tables: list[str]) -> None:
    print("Table row counts:")
    for t in tables:
        try:
            count = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"- {t}: {count}")
        except sqlite3.Error as exc:
            print(f"- {t}: <error: {exc}>")


def print_ts_association_summary(con: sqlite3.Connection) -> None:
    table = "time_series_associations"
    exists = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if not exists:
        return

    print("\nTime series associations summary:")
    rows = con.execute(
        """
        SELECT owner_category, time_series_type, COUNT(*)
        FROM time_series_associations
        GROUP BY owner_category, time_series_type
        ORDER BY owner_category, time_series_type
        """
    ).fetchall()
    if not rows:
        print("- <empty>")
        return

    for owner_category, ts_type, count in rows:
        print(f"- owner_category={owner_category}, type={ts_type}: {count}")


def print_sample(con: sqlite3.Connection, table: str, sample: int) -> None:
    print(f"\nSample rows from {table} (limit {sample}):")
    cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
    if not cols:
        print("- <no columns>")
        return

    rows = con.execute(f"SELECT * FROM {table} LIMIT ?", (sample,)).fetchall()
    if not rows:
        print("- <empty>")
        return

    print("- columns: " + ", ".join(cols))
    for row in rows:
        print("- " + repr(row))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "db_or_dir",
        type=Path,
        help="Path to time_series_metadata.db or *_time_series directory",
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=0,
        help="Print sample rows from each table (0 disables)",
    )
    args = parser.parse_args()

    db_path = resolve_db_path(args.db_or_dir)
    if not db_path.exists():
        print(f"error: database not found: {db_path}")
        return 2

    con = sqlite3.connect(db_path)
    try:
        tables = table_names(con)
        print(f"DB: {db_path}")
        print(f"Tables ({len(tables)}): {', '.join(tables) if tables else '<none>'}")

        print_counts(con, tables)
        print_ts_association_summary(con)

        if args.sample > 0:
            for t in tables:
                print_sample(con, t, args.sample)
    finally:
        con.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

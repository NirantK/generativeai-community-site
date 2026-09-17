#!/usr/bin/env python3
"""Generate a private idempotent D1 update that redacts phone numbers."""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chat_privacy import redact_text


def literal(value: str) -> str:
    return "'" + value.replace("'", "''").replace("\x00", "") + "'"


def build(rows):
    statements = []
    changed = 0
    for row in rows:
        row_id, author, body = str(row["id"]), str(row.get("author") or ""), str(row.get("body") or "")
        new_author, new_body = redact_text(author), redact_text(body)
        if (new_author, new_body) == (author, body):
            continue
        changed += 1
        statements.extend([
            f"DELETE FROM chat_search WHERE rowid=(SELECT rowid FROM chat_messages WHERE id={literal(row_id)});",
            f"UPDATE chat_messages SET author={literal(new_author)},body={literal(new_body)} WHERE id={literal(row_id)};",
            f"INSERT INTO chat_search(rowid,body,author) SELECT rowid,body,author FROM chat_messages WHERE id={literal(row_id)} AND hidden=0;",
        ])
    return "\n".join(statements) + ("\n" if statements else ""), changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    sql, changed = build(json.loads(args.rows.read_text()))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(sql)
    print(json.dumps({"rowsChanged": changed}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("Redaction preparation failed: " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)

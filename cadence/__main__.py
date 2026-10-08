"""Run the app: ``python -m cadence``.

Options can also come from the environment: CADENCE_DB, CADENCE_HOST,
CADENCE_PORT, CADENCE_STATIC, CADENCE_ALLOWED_HOSTS.
"""

from __future__ import annotations

import argparse
import os


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m cadence", description="Run the Cadence writing notebook.")
    parser.add_argument("--db", default=os.environ.get("CADENCE_DB"), help="path to the SQLite file")
    parser.add_argument("--host", default=os.environ.get("CADENCE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CADENCE_PORT", "8765")))
    parser.add_argument("--static", default=os.environ.get("CADENCE_STATIC"), help="built frontend directory")
    args = parser.parse_args()
    # Writing is private: new database and backup files are readable by this user only.
    os.umask(0o077)

    import uvicorn

    from .app import create_app

    app = create_app(args.db, args.static)
    print(f"Cadence: database {app.state.db_path}")
    print(f"Cadence: open http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/")
    # Access logs are off: request paths are harmless, but there is no reason
    # to keep a record of when and what was written.
    uvicorn.run(app, host=args.host, port=args.port, access_log=False, log_level="warning", proxy_headers=True)


if __name__ == "__main__":
    main()

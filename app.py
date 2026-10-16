
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

import os

# --------------------------------------------------
# LIBRAFLOW - LIBRARY MANAGEMENT BACKEND
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = BASE_DIR / "library.db"

app = Flask(__name__, static_folder=str(STATIC_DIR))
CORS(app)

# Protects critical book issue/return/reservation operations
library_lock = threading.Lock()


def get_db():
    """Create a separate database connection for each operation."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def initialize_database():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'General',
                total_copies INTEGER NOT NULL DEFAULT 1,
                available_copies INTEGER NOT NULL DEFAULT 1
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS issues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_id INTEGER NOT NULL,
                borrower TEXT NOT NULL,
                issued_at TEXT NOT NULL,
                returned_at TEXT,
                FOREIGN KEY (book_id) REFERENCES books(id)
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_id INTEGER NOT NULL,
                borrower TEXT NOT NULL,
                reserved_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'WAITING',
                FOREIGN KEY (book_id) REFERENCES books(id)
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        count = conn.execute(
            "SELECT COUNT(*) AS total FROM books"
        ).fetchone()["total"]

        if count == 0:
            sample_books = [
                ("Clean Code", "Robert C. Martin", "Programming", 3, 3),
                ("Python Crash Course", "Eric Matthes", "Programming", 4, 4),
                ("Database System Concepts", "Silberschatz", "Database", 2, 2),
                ("Operating System Concepts", "Silberschatz", "Operating Systems", 3, 3),
                ("Introduction to Algorithms", "Cormen", "Algorithms", 2, 2),
                ("Artificial Intelligence", "Stuart Russell", "AI", 2, 2),
                ("Computer Networks", "Andrew Tanenbaum", "Networking", 3, 3),
                ("The Pragmatic Programmer", "Andrew Hunt", "Programming", 2, 2),
            ]

            conn.executemany("""
                INSERT INTO books
                (title, author, category, total_copies, available_copies)
                VALUES (?, ?, ?, ?, ?)
            """, sample_books)

        conn.commit()


def log_activity(conn, message):
    conn.execute("""
        INSERT INTO activity_logs (message, created_at)
        VALUES (?, ?)
    """, (message, datetime.now().isoformat(timespec="seconds")))


def book_to_dict(row):
    return dict(row)


# --------------------------------------------------
# FRONTEND
# --------------------------------------------------

@app.route("/")
def home():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    # Serve only files within the static directory.
    return send_from_directory(STATIC_DIR, filename)


# --------------------------------------------------
# DASHBOARD
# --------------------------------------------------

@app.route("/api/stats", methods=["GET"])
def get_stats():
    with get_db() as conn:
        books = conn.execute("""
            SELECT
                COUNT(*) AS titles,
                COALESCE(SUM(total_copies), 0) AS total_copies,
                COALESCE(SUM(available_copies), 0) AS available_copies
            FROM books
        """).fetchone()

        issued = conn.execute("""
            SELECT COUNT(*) AS total
            FROM issues
            WHERE returned_at IS NULL
        """).fetchone()["total"]

        waiting = conn.execute("""
            SELECT COUNT(*) AS total
            FROM reservations
            WHERE status = 'WAITING'
        """).fetchone()["total"]

        return jsonify({
            "total_titles": books["titles"],
            "total_copies": books["total_copies"],
            "available_copies": books["available_copies"],
            "issued_books": issued,
            "waiting_reservations": waiting,
            "status": "Healthy"
        })


# --------------------------------------------------
# BOOK INVENTORY
# --------------------------------------------------

@app.route("/api/books", methods=["GET"])
def get_books():
    search = request.args.get("search", "").strip()

    with get_db() as conn:
        if search:
            pattern = f"%{search}%"
            rows = conn.execute("""
                SELECT * FROM books
                WHERE title LIKE ? OR author LIKE ? OR category LIKE ?
                ORDER BY id
            """, (pattern, pattern, pattern)).fetchall()
        else:
            rows = conn.execute("""
                SELECT * FROM books ORDER BY id
            """).fetchall()

        return jsonify([book_to_dict(row) for row in rows])


@app.route("/api/books", methods=["POST"])
def add_book():
    data = request.get_json(silent=True) or {}

    title = str(data.get("title", "")).strip()
    author = str(data.get("author", "")).strip()
    category = str(data.get("category", "General")).strip() or "General"

    try:
        copies = int(data.get("total_copies", 1))
    except (TypeError, ValueError):
        return jsonify({"error": "total_copies must be a number"}), 400

    if not title or not author:
        return jsonify({"error": "Title and author are required"}), 400

    if copies < 1 or copies > 10000:
        return jsonify({"error": "Copies must be between 1 and 10000"}), 400

    with library_lock:
        with get_db() as conn:
            cursor = conn.execute("""
                INSERT INTO books
                (title, author, category, total_copies, available_copies)
                VALUES (?, ?, ?, ?, ?)
            """, (title, author, category, copies, copies))

            book_id = cursor.lastrowid
            log_activity(conn, f"Added book: {title}")
            conn.commit()

    return jsonify({
        "message": "Book added successfully",
        "book_id": book_id
    }), 201


# --------------------------------------------------
# ISSUE A BOOK
# --------------------------------------------------

@app.route("/api/issue", methods=["POST"])
def issue_book():
    data = request.get_json(silent=True) or {}

    try:
        book_id = int(data.get("book_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "A valid book_id is required"}), 400

    borrower = str(data.get("borrower", "Student")).strip() or "Student"

    with library_lock:
        with get_db() as conn:
            book = conn.execute(
                "SELECT * FROM books WHERE id = ?", (book_id,)
            ).fetchone()

            if not book:
                return jsonify({"error": "Book not found"}), 404

            if book["available_copies"] <= 0:
                return jsonify({
                    "error": "No copies available. Reserve this book instead."
                }), 409

            # Conditional update prevents issuing an unavailable copy.
            cursor = conn.execute("""
                UPDATE books
                SET available_copies = available_copies - 1
                WHERE id = ? AND available_copies > 0
            """, (book_id,))

            if cursor.rowcount != 1:
                return jsonify({"error": "Book is no longer available"}), 409

            conn.execute("""
                INSERT INTO issues (book_id, borrower, issued_at)
                VALUES (?, ?, ?)
            """, (book_id, borrower, datetime.now().isoformat(timespec="seconds")))

            log_activity(conn, f"{borrower} issued {book['title']}")
            conn.commit()

    return jsonify({"message": f"'{book['title']}' issued successfully"})


# --------------------------------------------------
# RETURN A BOOK
# --------------------------------------------------

@app.route("/api/return", methods=["POST"])
def return_book():
    data = request.get_json(silent=True) or {}

    try:
        book_id = int(data.get("book_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "A valid book_id is required"}), 400

    with library_lock:
        with get_db() as conn:
            issue = conn.execute("""
                SELECT * FROM issues
                WHERE book_id = ? AND returned_at IS NULL
                ORDER BY id LIMIT 1
            """, (book_id,)).fetchone()

            if not issue:
                return jsonify({
                    "error": "No active issue record exists for this book"
                }), 404

            book = conn.execute(
                "SELECT * FROM books WHERE id = ?", (book_id,)
            ).fetchone()

            if not book:
                return jsonify({"error": "Book not found"}), 404

            conn.execute("""
                UPDATE issues SET returned_at = ?
                WHERE id = ? AND returned_at IS NULL
            """, (datetime.now().isoformat(timespec="seconds"), issue["id"]))

            # Give the returned copy to the first waiting reservation, if any.
            reservation = conn.execute("""
                SELECT * FROM reservations
                WHERE book_id = ? AND status = 'WAITING'
                ORDER BY id LIMIT 1
            """, (book_id,)).fetchone()

            if reservation:
                conn.execute("""
                    UPDATE reservations SET status = 'FULFILLED'
                    WHERE id = ?
                """, (reservation["id"],))

                conn.execute("""
                    INSERT INTO issues (book_id, borrower, issued_at)
                    VALUES (?, ?, ?)
                """, (
                    book_id,
                    reservation["borrower"],
                    datetime.now().isoformat(timespec="seconds")
                ))

                message = (
                    f"{book['title']} returned; allocated to "
                    f"{reservation['borrower']} from the reservation queue"
                )
            else:
                conn.execute("""
                    UPDATE books
                    SET available_copies = MIN(total_copies, available_copies + 1)
                    WHERE id = ?
                """, (book_id,))
                message = f"{book['title']} returned successfully"

            log_activity(conn, message)
            conn.commit()

    return jsonify({"message": message})


# --------------------------------------------------
# FIFO RESERVATION QUEUE
# --------------------------------------------------

@app.route("/api/reserve", methods=["POST"])
def reserve_book():
    data = request.get_json(silent=True) or {}

    try:
        book_id = int(data.get("book_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "A valid book_id is required"}), 400

    borrower = str(data.get("borrower", "Student")).strip() or "Student"

    with library_lock:
        with get_db() as conn:
            book = conn.execute(
                "SELECT * FROM books WHERE id = ?", (book_id,)
            ).fetchone()

            if not book:
                return jsonify({"error": "Book not found"}), 404

            existing = conn.execute("""
                SELECT id FROM reservations
                WHERE book_id = ? AND borrower = ? AND status = 'WAITING'
            """, (book_id, borrower)).fetchone()

            if existing:
                return jsonify({
                    "error": "This borrower already has a waiting reservation"
                }), 409

            cursor = conn.execute("""
                INSERT INTO reservations (book_id, borrower, reserved_at, status)
                VALUES (?, ?, ?, 'WAITING')
            """, (
                book_id,
                borrower,
                datetime.now().isoformat(timespec="seconds")
            ))

            position = conn.execute("""
                SELECT COUNT(*) AS position
                FROM reservations
                WHERE book_id = ?
                  AND status = 'WAITING'
                  AND id <= ?
            """, (book_id, cursor.lastrowid)).fetchone()["position"]

            log_activity(conn, f"{borrower} reserved {book['title']}")
            conn.commit()

    return jsonify({
        "message": "Reservation added to the FIFO queue",
        "queue_position": position
    }), 201


@app.route("/api/reservations", methods=["GET"])
def get_reservations():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                r.id, r.book_id, b.title AS book_title,
                r.borrower, r.reserved_at, r.status
            FROM reservations r
            JOIN books b ON b.id = r.book_id
            ORDER BY r.id DESC
        """).fetchall()

        return jsonify([dict(row) for row in rows])


# --------------------------------------------------
# ACTIVE ISSUES
# --------------------------------------------------

@app.route("/api/issues", methods=["GET"])
def get_issues():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                i.id, i.book_id, b.title AS book_title,
                i.borrower, i.issued_at
            FROM issues i
            JOIN books b ON b.id = i.book_id
            WHERE i.returned_at IS NULL
            ORDER BY i.id DESC
        """).fetchall()

        return jsonify([dict(row) for row in rows])


# --------------------------------------------------
# ACTIVITY LOGS
# --------------------------------------------------

@app.route("/api/logs", methods=["GET"])
def get_logs():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, message, created_at
            FROM activity_logs
            ORDER BY id DESC LIMIT 100
        """).fetchall()

        return jsonify([dict(row) for row in rows])


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.route("/api/health", methods=["GET"])
def health_check():
    try:
        with get_db() as conn:
            conn.execute("SELECT 1").fetchone()

        return jsonify({
            "status": "healthy",
            "database": "connected",
            "timestamp": datetime.now().isoformat(timespec="seconds")
        })
    except sqlite3.Error:
        return jsonify({
            "status": "unhealthy",
            "database": "error"
        }), 500


# --------------------------------------------------
# RUN SERVER
# --------------------------------------------------

initialize_database()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)

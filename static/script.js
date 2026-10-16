
/* ==========================================
   LIBRAFLOW - DATABASE CONNECTED FRONTEND
   Flask + SQLite + Mutex API
   ========================================== */

let books = [];
let waitlist = [];
let logEvents = 0;
let mutexLocked = false;
let requestCounter = 0;
let toastTimer;

const $ = id => document.getElementById(id);

const API = "https://libraflow-library-system-1.onrender.com/api";

const timeNow = () =>
    new Date().toLocaleTimeString("en-GB", { hour12: false });

function available(book) {
    return book.copies - book.checkedOut;
}

function total() {
    return books.reduce((sum, book) => sum + book.copies, 0);
}

function allAvailable() {
    return books.reduce((sum, book) => sum + available(book), 0);
}

function checkedOutTotal() {
    return books.reduce((sum, book) => sum + book.checkedOut, 0);
}

function colorFor(category = "") {
    const value = category.toLowerCase();

    if (value.includes("program") || value.includes("classic")) return "purple";
    if (value.includes("database") || value.includes("self")) return "teal";
    if (value.includes("history") || value.includes("network")) return "blue";
    if (value.includes("design")) return "green";
    if (value.includes("ai")) return "pink";

    return "orange";
}

/* ---------- API REQUEST ---------- */

async function apiRequest(endpoint, options = {}) {
    const response = await fetch(`${API}/${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error("Server returned an invalid response.");
    }

    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }

    return data;
}

/* ---------- LOG CONSOLE ---------- */

function log(message, level = "info") {
    const body = $("consoleBody");
    if (!body) {
        console.log(message);
        return;
    }

    const line = document.createElement("div");
    line.className = `log-line ${level}`;

    const label =
        level === "error" ? "ERR" :
        level === "warn" ? "WARN" :
        level === "success" ? "OK" : "INFO";

    const timestamp = document.createElement("span");
    timestamp.className = "log-time";
    timestamp.textContent = timeNow();

    const levelElement = document.createElement("span");
    levelElement.className = "log-level";
    levelElement.textContent = label;

    const messageElement = document.createElement("span");
    messageElement.textContent = message;

    line.append(timestamp, levelElement, messageElement);
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;

    logEvents++;

    if ($("logCount")) {
        $("logCount").textContent = `${logEvents} EVENTS`;
    }
}

function toast(message) {
    const element = $("toast");

    if (!element) {
        console.log(message);
        return;
    }

    element.textContent = message;
    element.classList.add("show");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        element.classList.remove("show");
    }, 2600);
}

/* ---------- MUTEX DISPLAY ---------- */

function setMutex(locked, owner = "none") {
    mutexLocked = locked;

    const banner = document.querySelector(".mutex-banner");

    if (banner) banner.classList.toggle("locked", locked);

    if ($("mutexTitle")) {
        $("mutexTitle").textContent = locked
            ? "Mutex acquired — critical section active"
            : "Mutex is idle";
    }

    if ($("mutexMessage")) {
        $("mutexMessage").textContent = locked
            ? `${owner} has exclusive access. Other requests must wait.`
            : "No active transaction. Inventory is safe to access.";
    }

    if ($("mutexBadge")) {
        $("mutexBadge").textContent = locked ? "LOCKED" : "UNLOCKED";
    }

    if ($("mutexOwner")) {
        $("mutexOwner").textContent =
            `Owner: ${locked ? owner : "none"}`;
    }

    if ($("mutexLight")) {
        $("mutexLight").style.background =
            locked ? "var(--red)" : "var(--green)";
    }
}

/* ---------- LOAD REAL DATABASE DATA ---------- */

async function loadBooks(search = "") {
    const query = new URLSearchParams({ search });
    const rows = await apiRequest(`books?${query}`);

    // Convert Flask's database fields to the frontend's existing format.
    books = rows.map(row => ({
        id: String(row.id),
        title: row.title,
        author: row.author,
        category: row.category.toUpperCase(),
        color: colorFor(row.category),
        copies: Number(row.total_copies),
        checkedOut:
            Number(row.total_copies) - Number(row.available_copies)
    }));

    return books;
}

async function loadReservations() {
    const rows = await apiRequest("reservations");

    waitlist = rows
        .filter(row => row.status === "WAITING")
        .map(row => ({
            id: row.id,
            bookId: String(row.book_id),
            title: row.book_title,
            user: row.borrower,
            at: new Date(row.reserved_at).getTime()
        }));
}

async function refreshDashboard() {
    await Promise.all([
        loadBooks(),
        loadReservations()
    ]);

    render();
}

/* ---------- STATISTICS ---------- */

function renderStats() {
    if ($("totalCopies")) {
        $("totalCopies").textContent = total();
    }

    if ($("availableCopies")) {
        $("availableCopies").textContent = allAvailable();
    }

    if ($("checkedOutCopies")) {
        $("checkedOutCopies").textContent = checkedOutTotal();
    }

    if ($("queueCount")) {
        $("queueCount").textContent = waitlist.length;
    }

    if ($("availabilityText")) {
        $("availabilityText").textContent =
            allAvailable() === 0 ? "All copies are in use" : "Ready to issue";
    }

    if ($("queuePill")) {
        $("queuePill").textContent = `${waitlist.length} waiting`;
    }
}

/* ---------- BOOK SELECTOR ---------- */

function renderBookOptions() {
    const select = $("raceBook");
    if (!select) return;

    const previous = select.value;
    select.innerHTML = "";

    books.forEach(book => {
        const option = document.createElement("option");
        option.value = book.id;
        option.textContent = book.title;
        select.appendChild(option);
    });

    if (books.some(book => book.id === previous)) {
        select.value = previous;
    }
}

/* ---------- BOOK CATALOG ---------- */

function renderCatalog() {
    const grid = $("catalogGrid");
    if (!grid) return;

    const query = $("searchInput")?.value.trim().toLowerCase() || "";

    grid.innerHTML = "";

    const filtered = books.filter(book =>
        `${book.title} ${book.author} ${book.category}`
            .toLowerCase()
            .includes(query)
    );

    if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No matching titles found.";
        grid.appendChild(empty);
        return;
    }

    filtered.forEach(book => {
        const free = available(book);

        const card = document.createElement("article");
        card.className = "book-card";

        const top = document.createElement("div");
        top.className = "book-top";

        const cover = document.createElement("div");
        cover.className = `book-cover cover-${book.color}`;
        cover.textContent = book.title
            .split(/\s+/)
            .slice(0, 2)
            .map(word => word[0])
            .join("")
            .toUpperCase();

        const meta = document.createElement("div");
        meta.className = "book-meta";

        const title = document.createElement("h3");
        title.textContent = book.title;

        const author = document.createElement("p");
        author.textContent = book.author;

        const category = document.createElement("span");
        category.className = "category-chip";
        category.textContent = book.category;

        meta.append(title, author, category);
        top.append(cover, meta);

        const stock = document.createElement("div");
        stock.className = "stock-line";

        const stockLabel = document.createElement("span");
        stockLabel.textContent = "AVAILABLE COPIES";

        const stockValue = document.createElement("b");
        stockValue.textContent = `${free} / ${book.copies}`;

        stock.append(stockLabel, stockValue);

        const dots = document.createElement("div");
        dots.className = "copy-dots";

        for (let i = 0; i < book.copies; i++) {
            const dot = document.createElement("span");
            dot.className = "copy-dot " + (i < free ? "available" : "out");
            dots.appendChild(dot);
        }

        const actions = document.createElement("div");
        actions.className = "book-actions";

        const issueButton = document.createElement("button");
        issueButton.className = "button button-issue";
        issueButton.textContent = "↗ Issue copy";
        issueButton.disabled = free === 0;
        issueButton.addEventListener("click", () => {
            issueBook(book.id, "Operator");
        });

        const returnButton = document.createElement("button");
        returnButton.className = "button button-return";
        returnButton.textContent = "↙ Return copy";
        returnButton.disabled = book.checkedOut === 0;
        returnButton.addEventListener("click", () => {
            returnBook(book.id);
        });

        const reserveButton = document.createElement("button");
        reserveButton.className = "button";
        reserveButton.textContent = "Join queue";
        reserveButton.addEventListener("click", () => {
            reserveBook(book.id, "Operator");
        });

        actions.append(issueButton, returnButton, reserveButton);
        card.append(top, stock, dots, actions);
        grid.appendChild(card);
    });
}

/* ---------- FIFO QUEUE ---------- */

function renderQueue() {
    const body = $("queueTable");
    if (!body) return;

    body.innerHTML = "";

    if ($("queueEmpty")) {
        $("queueEmpty").style.display =
            waitlist.length > 0 ? "none" : "block";
    }

    waitlist.forEach((item, index) => {
        const row = document.createElement("tr");

        [
            String(index + 1).padStart(2, "0"),
            item.user,
            item.title
        ].forEach(value => {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
        });

        const statusCell = document.createElement("td");
        const status = document.createElement("span");
        status.className = "queue-status";
        status.textContent = "● WAITING";

        statusCell.appendChild(status);
        row.appendChild(statusCell);
        body.appendChild(row);
    });
}

/* ---------- RENDER ---------- */

function render() {
    renderStats();
    renderCatalog();
    renderQueue();
    renderBookOptions();
}

/* ---------- ISSUE BOOK VIA BACKEND ---------- */

async function issueBook(bookId, user = "Operator") {
    if (mutexLocked) {
        toast("A request is already running. Please retry.");
        return;
    }

    const book = books.find(item => item.id === String(bookId));
    if (!book) return;

    setMutex(true, user);

    try {
        log(`ISSUE_REQUEST user=${user}, book=${book.title}`);

        const result = await apiRequest("issue", {
            method: "POST",
            body: JSON.stringify({
                book_id: Number(bookId),
                borrower: user
            })
        });

        log(result.message, "success");
        toast(result.message);

    } catch (error) {
        log(error.message, "warn");

        // If no copies remain, offer to reserve instead.
        if (error.message.includes("No copies available")) {
            const shouldReserve = confirm(
                `No copies of "${book.title}" are available. Join the waiting queue?`
            );

            if (shouldReserve) {
                await reserveBook(bookId, user);
            }
        } else {
            toast(error.message);
        }
    } finally {
        setMutex(false);
        await refreshDashboard();
    }
}

/* ---------- RETURN BOOK VIA BACKEND ---------- */

async function returnBook(bookId) {
    if (mutexLocked) {
        toast("A request is already running. Please retry.");
        return;
    }

    setMutex(true, "Operator / Return");

    try {
        const result = await apiRequest("return", {
            method: "POST",
            body: JSON.stringify({
                book_id: Number(bookId)
            })
        });

        log(result.message, "success");
        toast(result.message);

    } catch (error) {
        log(error.message, "error");
        toast(error.message);
    } finally {
        setMutex(false);
        await refreshDashboard();
    }
}

/* ---------- RESERVE BOOK VIA BACKEND ---------- */

async function reserveBook(bookId, user = "Operator") {
    try {
        const result = await apiRequest("reserve", {
            method: "POST",
            body: JSON.stringify({
                book_id: Number(bookId),
                borrower: user
            })
        });

        log(
            `${user} added to queue. Position ${result.queue_position}`,
            "success"
        );

        toast(`Reservation successful. Queue position: ${result.queue_position}`);
        await refreshDashboard();

    } catch (error) {
        log(error.message, "warn");
        toast(error.message);
    }
}

/* ---------- USER LANES ---------- */

function setLane(user, status, message) {
    const suffix = user === "User A" ? "A" : "B";
    const lane = $("lane" + suffix);
    const badge = $("user" + suffix + "Badge");
    const statusText = $("user" + suffix + "Status");

    if (lane) {
        lane.classList.remove("busy", "done");

        if (status === "BLOCKED") lane.classList.add("busy");

        if (["ISSUED", "QUEUED"].includes(status)) {
            lane.classList.add("done");
        }
    }

    if (badge) badge.textContent = status;
    if (statusText) statusText.textContent = message;
}

/* ---------- REAL BACKEND RACE TEST ---------- */

async function runRace() {
    if (mutexLocked) {
        toast("A transaction is already running.");
        return;
    }

    const bookId = $("raceBook")?.value;
    const book = books.find(item => item.id === String(bookId));

    if (!book) {
        toast("Select a book first.");
        return;
    }

    const button = $("raceBtn");
    if (button) button.disabled = true;

    requestCounter++;

    setLane("User A", "WAITING", "Request sent to backend");
    setLane("User B", "WAITING", "Waiting for User A");

    log(`RACE_TEST #${requestCounter}: ${book.title}`);

    try {
        // Requests are made to the Flask backend. Its server-side lock
        // protects the shared inventory during each operation.
        setLane("User A", "LOCKED", "Requesting database transaction");
        const resultA = await attemptRaceRequest(book.id, "User A");

        setLane(
            "User A",
            resultA.issued ? "ISSUED" : "QUEUED",
            resultA.message
        );

        setLane("User B", "WAITING", "Requesting after User A");

        const resultB = await attemptRaceRequest(book.id, "User B");

        setLane(
            "User B",
            resultB.issued ? "ISSUED" : "QUEUED",
            resultB.message
        );

        log(`User A: ${resultA.message}`, resultA.issued ? "success" : "warn");
        log(`User B: ${resultB.message}`, resultB.issued ? "success" : "warn");

        toast("Both requests processed by the backend.");
    } catch (error) {
        log(error.message, "error");
        toast(error.message);
    } finally {
        setMutex(false);
        if (button) button.disabled = false;
        await refreshDashboard();
    }
}

async function attemptRaceRequest(bookId, user) {
    try {
        const result = await apiRequest("issue", {
            method: "POST",
            body: JSON.stringify({
                book_id: Number(bookId),
                borrower: user
            })
        });

        return { issued: true, message: result.message };

    } catch (error) {
        if (error.message.includes("No copies available")) {
            const queued = await apiRequest("reserve", {
                method: "POST",
                body: JSON.stringify({
                    book_id: Number(bookId),
                    borrower: user
                })
            });

            return {
                issued: false,
                message: `Added to FIFO queue at position ${queued.queue_position}`
            };
        }

        throw error;
    }
}

/* ---------- ADD BOOK ---------- */

async function addBook() {
    const samples = [
        {
            title: "The Pragmatic Programmer",
            author: "Andrew Hunt",
            category: "Technology"
        },
        {
            title: "Thinking, Fast and Slow",
            author: "Daniel Kahneman",
            category: "Psychology"
        },
        {
            title: "The Alchemist",
            author: "Paulo Coelho",
            category: "Fiction"
        }
    ];

    const next = samples.find(
        item => !books.some(book => book.title === item.title)
    );

    if (!next) {
        toast("All sample titles have already been added.");
        return;
    }

    try {
        const result = await apiRequest("books", {
            method: "POST",
            body: JSON.stringify({
                ...next,
                total_copies: 2
            })
        });

        log(result.message, "success");
        toast(result.message);
        await refreshDashboard();

    } catch (error) {
        log(error.message, "error");
        toast(error.message);
    }
}

/* ---------- RESET VIEW ---------- */

// This refreshes from the database; it does NOT erase saved transactions.
async function resetDemo() {
    if (mutexLocked) {
        toast("Wait for the current transaction to finish.");
        return;
    }

    requestCounter = 0;

    if ($("consoleBody")) $("consoleBody").innerHTML = "";
    logEvents = 0;

    if ($("logCount")) $("logCount").textContent = "0 EVENTS";

    setLane("User A", "READY", "Ready to request a book");
    setLane("User B", "READY", "Ready to request a book");

    setMutex(false);

    try {
        await refreshDashboard();
        log("Dashboard refreshed from the database", "success");
        toast("Database data reloaded.");
    } catch (error) {
        log(error.message, "error");
        toast(error.message);
    }
}

/* ---------- EVENT LISTENERS ---------- */

if ($("raceBtn")) {
    $("raceBtn").addEventListener("click", runRace);
}

if ($("searchInput")) {
    $("searchInput").addEventListener("input", renderCatalog);
}

if ($("addBookBtn")) {
    $("addBookBtn").addEventListener("click", addBook);
}

if ($("resetBtn")) {
    $("resetBtn").addEventListener("click", resetDemo);
}

if ($("clearLogBtn")) {
    $("clearLogBtn").addEventListener("click", () => {
        if ($("consoleBody")) $("consoleBody").innerHTML = "";
        logEvents = 0;

        if ($("logCount")) $("logCount").textContent = "0 EVENTS";
        log("Console cleared");
    });
}

/* ---------- LIVE CLOCK ---------- */

function updateClock() {
    if ($("liveClock")) {
        $("liveClock").textContent = `● LIVE · ${timeNow()}`;
    }
}

updateClock();
setInterval(updateClock, 1000);

/* Automatic Dashboard Synchronization */

let autoRefreshInProgress = false;

setInterval(async () => {
    if (autoRefreshInProgress) {
        return;
    }

    autoRefreshInProgress = true;

    try {
        await refreshDashboard();
    } catch (error) {
        console.error(
            "Automatic dashboard refresh failed:",
            error
        );
    } finally {
        autoRefreshInProgress = false;
    }
}, 5000);


/* ---------- INITIALIZE ---------- */

async function initializeDashboard() {
    log("Connecting to Flask backend...");

    try {
        await refreshDashboard();

        log("Backend connected successfully", "success");
        log("Inventory loaded from SQLite database", "success");
        log("FIFO reservation queue loaded", "success");

    } catch (error) {
        log(`Backend connection failed: ${error.message}`, "error");
        toast("Backend connection failed. Check Flask terminal.");
    }
}

initializeDashboard();

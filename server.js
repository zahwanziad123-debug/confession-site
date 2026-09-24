require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const initSqlJs = require("sql.js");

const app = express();

const PORT = process.env.PORT || 3000;

const ADMIN_USER =
    process.env.ADMIN_USER || "admin";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "change-me";

const INSTAGRAM_API_KEY =
    process.env.INSTAGRAM_API_KEY || "";

const DATA_DIR =
    path.join(__dirname, "data");

const DB_FILE =
    path.join(DATA_DIR, "confessions.sqlite");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

let db;

function saveDatabase() {
    const data = db.export();

    fs.writeFileSync(
        DB_FILE,
        Buffer.from(data)
    );
}

function cleanInstagramUsername(value) {
    let username = String(value || "")
        .trim()
        .replace(/^@+/, "");

    if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
        return null;
    }

    return username;
}

function adminAuth(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Basic ")) {
        res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Confessions Admin"'
        );

        return res
            .status(401)
            .send("Authentication required.");
    }

    let decoded;

    try {
        decoded = Buffer
            .from(header.slice(6), "base64")
            .toString("utf8");
    } catch {
        return res
            .status(401)
            .send("Invalid authentication.");
    }

    const separator = decoded.indexOf(":");

    if (separator === -1) {
        return res
            .status(401)
            .send("Invalid authentication.");
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (
        username !== ADMIN_USER ||
        password !== ADMIN_PASSWORD
    ) {
        res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Confessions Admin"'
        );

        return res
            .status(401)
            .send("Invalid username or password.");
    }

    next();
}

async function lookupInstagramProfile(username) {
    if (!INSTAGRAM_API_KEY) {
        throw new Error(
            "INSTAGRAM_API_KEY is not configured."
        );
    }

    const apiUrl =
        "https://api.captapi.com/v1/instagram/profile-search?q=" +
        encodeURIComponent(username) +
        "&cache=true";

    const response = await fetch(apiUrl, {
        method: "GET",

        headers: {
            "Authorization":
                `Bearer ${INSTAGRAM_API_KEY}`,

            "Accept":
                "application/json"
        },

        signal: AbortSignal.timeout(15000)
    });

    let data = null;

    try {
        data = await response.json();
    } catch {
        data = null;
    }

    if (!response.ok) {
        console.error(
            "CaptAPI error:",
            response.status,
            data
        );

        if (
            response.status === 401 ||
            response.status === 403
        ) {
            throw new Error(
                "CaptAPI authentication failed."
            );
        }

        if (response.status === 429) {
            throw new Error(
                "CaptAPI rate limit reached."
            );
        }

        throw new Error(
            "CaptAPI request failed."
        );
    }

    /*
     * CaptAPI returns the resolved profiles
     * inside the users array.
     *
     * We support both:
     *   { users: [...] }
     * and
     *   { data: { users: [...] } }
     * so the server is tolerant of response
     * wrapping.
     */

    let users = [];

    if (
        data &&
        Array.isArray(data.users)
    ) {
        users = data.users;
    } else if (
        data &&
        data.data &&
        Array.isArray(data.data.users)
    ) {
        users = data.data.users;
    }

    if (users.length === 0) {
        return {
            exists: false
        };
    }

    /*
     * Make sure we aren't simply accepting
     * an unrelated search result.
     */

    const exactMatch = users.find(user => {
        return String(
            user.username || ""
        ).toLowerCase() === username.toLowerCase();
    });

    if (!exactMatch) {
        return {
            exists: false
        };
    }

    return {
        exists: true,

        username:
            exactMatch.username ||
            username,

        id:
            exactMatch.id ||
            null,

        displayName:
            exactMatch.displayName ||
            exactMatch.fullName ||
            null,

        verified:
            exactMatch.verified === true ||
            exactMatch.isVerified === true,

        isPrivate:
            exactMatch.isPrivate === true ||
            exactMatch.private === true,

        url:
            exactMatch.url ||
            `https://www.instagram.com/${exactMatch.username || username}/`
    };
}

async function startServer() {
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_FILE)) {
        const file = fs.readFileSync(DB_FILE);

        db = new SQL.Database(file);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS confessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT NOT NULL,
            instagram_username TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    /*
     * If an older database was created before
     * instagram_username was required, make sure
     * the column exists.
     */

    try {
        const columns = db.exec(`
            PRAGMA table_info(confessions)
        `);

        if (columns.length) {
            const names = columns[0].values.map(
                row => row[1]
            );

            if (!names.includes("instagram_username")) {
                db.run(`
                    ALTER TABLE confessions
                    ADD COLUMN instagram_username TEXT
                `);
            }
        }
    } catch (error) {
        console.error(
            "Database migration warning:",
            error.message
        );
    }

    saveDatabase();

    app.use(express.json({
        limit: "20kb"
    }));

    app.use(express.urlencoded({
        extended: true,
        limit: "20kb"
    }));

    app.use(
        express.static(
            path.join(__dirname, "public")
        )
    );

    /*
     * Instagram username verification
     */

    app.get(
        "/api/check-instagram",
        async (req, res) => {
            const username =
                cleanInstagramUsername(
                    req.query.username
                );

            if (!username) {
                return res.status(400).json({
                    exists: false,
                    error:
                        "Invalid Instagram username."
                });
            }

            try {
                const profile =
                    await lookupInstagramProfile(
                        username
                    );

                return res.json({
                    exists:
                        profile.exists,

                    username:
                        profile.username ||
                        username,

                    verified:
                        profile.verified ||
                        false,

                    isPrivate:
                        profile.isPrivate ||
                        false
                });

            } catch (error) {
                console.error(
                    "Instagram lookup error:",
                    error.message
                );

                return res.status(503).json({
                    exists: false,
                    error:
                        "Unable to verify Instagram right now."
                });
            }
        }
    );

    /*
     * Submit confession
     */

    app.post(
        "/api/confession",
        async (req, res) => {
            const message =
                String(
                    req.body.message || ""
                ).trim();

            const username =
                cleanInstagramUsername(
                    req.body.instagram_username
                );

            if (!message) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Confession is empty."
                });
            }

            if (message.length > 1000) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Confession is too long."
                });
            }

            if (!username) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Valid Instagram username required."
                });
            }

            try {
                /*
                 * Verify again on the server.
                 * Never trust the green check in the browser.
                 */

                const profile =
                    await lookupInstagramProfile(
                        username
                    );

                if (!profile.exists) {
                    return res.status(400).json({
                        success: false,
                        error:
                            "Instagram profile not found."
                    });
                }

                const verifiedUsername =
                    profile.username ||
                    username;

                db.run(
                    `
                    INSERT INTO confessions
                    (
                        message,
                        instagram_username
                    )
                    VALUES (?, ?)
                    `,
                    [
                        message,
                        verifiedUsername
                    ]
                );

                saveDatabase();

                return res.json({
                    success: true
                });

            } catch (error) {
                console.error(
                    "Submission error:",
                    error.message
                );

                return res.status(503).json({
                    success: false,
                    error:
                        "Unable to verify Instagram right now. Please try again."
                });
            }
        }
    );

    /*
     * Admin API
     */

    app.get(
        "/api/confessions",
        adminAuth,
        (req, res) => {
            const result = db.exec(`
                SELECT
                    id,
                    message,
                    instagram_username,
                    created_at
                FROM confessions
                ORDER BY id DESC
            `);

            if (!result.length) {
                return res.json([]);
            }

            const columns =
                result[0].columns;

            const values =
                result[0].values;

            const rows =
                values.map(row => {
                    const item = {};

                    columns.forEach(
                        (column, index) => {
                            item[column] =
                                row[index];
                        }
                    );

                    return item;
                });

            res.json(rows);
        }
    );

    app.delete(
        "/api/confession/:id",
        adminAuth,
        (req, res) => {
            const id =
                Number(req.params.id);

            if (!Number.isInteger(id)) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid confession ID."
                });
            }

            db.run(
                `
                DELETE FROM confessions
                WHERE id = ?
                `,
                [id]
            );

            saveDatabase();

            return res.json({
                success: true
            });
        }
    );

    /*
     * Admin page
     */

    app.get(
        "/admin",
        adminAuth,
        (req, res) => {
            res.sendFile(
                path.join(
                    __dirname,
                    "public",
                    "admin.html"
                )
            );
        }
    );

    app.listen(
        PORT,
        () => {
            console.log("");
            console.log(
                "================================"
            );
            console.log(
                " Confession website is running"
            );
            console.log(
                ` http://localhost:${PORT}`
            );
            console.log(
                ` http://localhost:${PORT}/admin`
            );
            console.log(
                "================================"
            );
            console.log("");
        }
    );
}

startServer().catch(error => {
    console.error(
        "Failed to start server:"
    );

    console.error(error);
});

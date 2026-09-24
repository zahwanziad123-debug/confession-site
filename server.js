require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;

const ADMIN_USER =
    process.env.ADMIN_USER || "admin";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "change-me";

const INSTAGRAM_API_KEY =
    process.env.INSTAGRAM_API_KEY || "";

const SUPABASE_URL =
    process.env.SUPABASE_URL || "";

const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function supabaseRequest(pathname, options = {}) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Supabase environment variables are not configured.");
    }

    const response = await fetch(
        SUPABASE_URL.replace(/\\/$/, "") + pathname,
        {
            ...options,
            headers: {
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                ...(options.headers || {})
            },
            signal: AbortSignal.timeout(15000)
        }
    );

    const text = await response.text();
    let data = null;

    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }

    if (!response.ok) {
        console.error("Supabase error:", response.status, data);
        throw new Error("Supabase request failed.");
    }

    return data;
}

async function insertConfession(message, instagramUsername) {
    return supabaseRequest("/rest/v1/confessions", {
        method: "POST",
        headers: {
            "Prefer": "return=minimal"
        },
        body: JSON.stringify({
            message,
            instagram_username: instagramUsername
        })
    });
}

async function listConfessions() {
    return supabaseRequest(
        "/rest/v1/confessions?select=id,message,instagram_username,created_at&order=id.desc",
        { method: "GET" }
    );
}

async function deleteConfession(id) {
    return supabaseRequest(
        "/rest/v1/confessions?id=eq." + encodeURIComponent(id),
        { method: "DELETE", headers: { "Prefer": "return=minimal" } }
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
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured."
        );
    }

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

                await insertConfession(
                    message,
                    verifiedUsername
                );

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
                        "Unable to save your confession right now. Please try again."
                });
            }
        }
    );

    app.get(
        "/api/confessions",
        adminAuth,
        async (req, res) => {
            try {
                const rows = await listConfessions();
                return res.json(rows);
            } catch (error) {
                console.error(
                    "Admin list error:",
                    error.message
                );

                return res.status(503).json({
                    error:
                        "Unable to load confessions right now."
                });
            }
        }
    );

    app.delete(
        "/api/confession/:id",
        adminAuth,
        async (req, res) => {
            const id =
                Number(req.params.id);

            if (!Number.isInteger(id)) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid confession ID."
                });
            }

            try {
                await deleteConfession(id);

                return res.json({
                    success: true
                });
            } catch (error) {
                console.error(
                    "Delete error:",
                    error.message
                );

                return res.status(503).json({
                    success: false,
                    error:
                        "Unable to delete confession right now."
                });
            }
        }
    );

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
        "0.0.0.0",
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
                " Supabase persistence enabled"
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

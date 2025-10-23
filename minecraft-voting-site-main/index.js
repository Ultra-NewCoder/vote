// server.js
const express = require("express");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
const util = require("minecraft-server-util");
const app = express();
require("dotenv").config();

// data
const IP = process.env.IP;
const PORT = parseInt(process.env.PORT);
const VOTIFIER_TOKEN = process.env.VOTIFIER_TOKEN;
const SERVICE_NAME = process.env.SERVICE_NAME;

// Middleware
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Define constants
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const VOTE_DATA_FILE = path.join(__dirname, "data/votes.yml");

// IP address detection helper
const getClientIP = (req) => {
    // Logic remains the same for robust IP detection
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
        return forwarded.split(",")[0];
    }
    const realIP = req.headers["x-real-ip"];
    if (realIP) {
        return realIP;
    }
    const ip = req.connection.remoteAddress;
    if (ip === "::1" || ip === "::ffff:127.0.0.1") {
        return "127.0.0.1";
    }
    return ip.replace(/^::ffff:/, "");
};

// Load and Save Vote Data (Single Site)
const loadVoteData = () => {
    try {
        // Ensure data directory exists
        if (!fs.existsSync(path.dirname(VOTE_DATA_FILE))) {
            fs.mkdirSync(path.dirname(VOTE_DATA_FILE), { recursive: true });
        }
        if (fs.existsSync(VOTE_DATA_FILE)) {
            return yaml.load(fs.readFileSync(VOTE_DATA_FILE, "utf8")) || {};
        }
        return {};
    } catch (e) {
        console.error("Error loading vote data:", e);
        return {};
    }
};

const saveVoteData = (voteData) => {
    try {
        fs.writeFileSync(VOTE_DATA_FILE, yaml.dump(voteData));
    } catch (e) {
        console.error("Error saving vote data:", e);
        throw e;
    }
};

// Check cooldown period
const checkCooldown = (voteData, username, ip) => {
    const now = Date.now();
    const userVote = voteData.users?.[username];
    
    // Check user cooldown
    if (userVote && now - userVote.timestamp < COOLDOWN_MS) {
        const remaining = Math.ceil((userVote.timestamp + COOLDOWN_MS - now) / 1000 / 60);
        return { canVote: false, type: 'user', remaining };
    }

    // Check IP cooldown (finding any user associated with this IP)
    const ipRecord = voteData.ips?.[ip];
    if (ipRecord && now - ipRecord.timestamp < COOLDOWN_MS) {
        const remaining = Math.ceil((ipRecord.timestamp + COOLDOWN_MS - now) / 1000 / 60);
        return { canVote: false, type: 'ip', remaining };
    }

    return { canVote: true, remaining: 0 };
};


// Send vote to Minecraft server (Votifier V2)
const sendVoteToServer = async (username) => {
    try {
        await util.sendVote(IP, PORT, {
            token: VOTIFIER_TOKEN,
            username,
            serviceName: SERVICE_NAME,
            timestamp: Date.now(),
            timeout: 5000,
        });
        return true;
    } catch (e) {
        console.error("Error sending vote to server:", e);
        return false;
    }
};

// --- ROUTES ---

// Home page / Vote Submission Page
app.get("/", (req, res) => {
    res.render("vote", { serviceName: SERVICE_NAME, cooldown: null });
});

// Handle vote submission
app.post("/vote", async (req, res) => {
    const { username } = req.body;
    const clientIP = getClientIP(req);

    // Validate username
    if (!username || username.length > 16 || !/^[a-zA-Z0-9_.]{3,16}$/.test(username)) {
        return res.render("error", {
            message: "Invalid username format. Must be 3-16 characters long.",
        });
    }

    try {
        const voteData = loadVoteData();
        const cooldownCheck = checkCooldown(voteData, username, clientIP);

        if (!cooldownCheck.canVote) {
            return res.render("error", {
                message: `You must wait ${cooldownCheck.remaining} minutes before voting again.`,
            });
        }

        const voteSuccess = await sendVoteToServer(username);
        
        if (!voteSuccess) {
            return res.render("error", {
                message: "Failed to connect or send vote to server. Please check configurations.",
            });
        }

        // Save vote data (using users and ips objects for simpler lookups)
        const newVoteData = {
            users: voteData.users || {},
            ips: voteData.ips || {}
        };
        
        newVoteData.users[username] = { ip: clientIP, timestamp: Date.now() };
        newVoteData.ips[clientIP] = { username, timestamp: Date.now() };

        saveVoteData(newVoteData);

        // Redirect to success page
        res.render("success", { serviceName: SERVICE_NAME });
    } catch (error) {
        console.error("Vote processing error:", error);
        res.render("error", {
            message: "An internal server error occurred while processing your vote.",
        });
    }
});


// Fallback route
app.get("*", (req, res) => {
    res.status(404).render("error", { message: "Page not found." });
});


// Start server
const SERVER_PORT = process.env.WEBSITE_PORT || 3000;
app.listen(SERVER_PORT, () => {
    console.log(`Server running on port http://localhost:${SERVER_PORT}`);
});
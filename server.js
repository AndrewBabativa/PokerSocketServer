import express from "express";
import http from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";

// ==========================================
// 1. CONFIGURACIÓN DEL SERVIDOR
// ==========================================
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ⚠️ CORRECCIÓN 1: Middleware para entender JSON (Vital para recibir datos de C#)
app.use(express.json());

// ⚠️ CORRECCIÓN 2: Ruta de Health Check para Render
// Render llama aquí para saber si el server está vivo. Si no existe, da "Timed Out".
app.get('/', (req, res) => {
    res.status(200).send("Poker Socket Server is Running 🚀");
});

// URL de tu Backend C#
const BACKEND_API = "https://pokergenysbackend.onrender.com/api/Tournaments";

const io = new Server(server, {
    cors: {
        // Asegúrate de que estas URLS son correctas (sin barras al final a veces ayuda)
        origin: ["https://pokergenys.netlify.app", "http://localhost:5173"], 
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ["websocket", "polling"]
});

// ==========================================
// 2. WEBHOOK (Comunicación C# -> Node)
// ==========================================
app.post('/api/webhook/emit', (req, res) => {
    // Gracias a 'app.use(express.json())', ahora req.body sí tiene datos
    const { tournamentId, event, data } = req.body;

    if (!tournamentId || !event) {
        console.warn("[Webhook] Intento fallido: Faltan datos", req.body);
        return res.status(400).send("Faltan datos");
    }

    const room = tournamentRoom(tournamentId);
    
    console.log(`[Webhook C#] Emitiendo '${event}' a sala ${room}`);
    
    // Emitir a la sala específica
    io.to(room).emit(event, data);

    res.status(200).send({ success: true });
});

// ==========================================
// 3. ESTADO EN MEMORIA
// ==========================================
const activeTournaments = new Map();
const tournamentRoom = (id) => `tournament:${id}`;
const displays = new Map();

// ==========================================
// 4. LÓGICA DE NEGOCIO (REPLICA DE C#)
// ==========================================

function calculateState(startTimeStr, levels) {
    if (!startTimeStr || !levels || levels.length === 0) return null;

    const now = Date.now();
    const startTime = new Date(startTimeStr).getTime(); 
    
    const elapsedMs = now - startTime;

    let levelIndex = 0;
    let levelStartMs = 0;
    let timeRemainingSeconds = 0;
    let found = false;

    const sortedLevels = levels.sort((a, b) => a.levelNumber - b.levelNumber);

    for (let i = 0; i < sortedLevels.length; i++) {
        const lvl = sortedLevels[i];
        const durationMs = lvl.durationSeconds * 1000;

        if (elapsedMs < (levelStartMs + durationMs)) {
            timeRemainingSeconds = (levelStartMs + durationMs - elapsedMs) / 1000;
            levelIndex = i;
            found = true;
            break;
        }
        levelStartMs += durationMs;
    }

    if (!found) {
        return { finished: true, currentLevel: sortedLevels.length + 1, timeRemaining: 0 };
    }

    return {
        finished: false,
        currentLevel: sortedLevels[levelIndex].levelNumber,
        timeRemaining: Math.ceil(timeRemainingSeconds)
    };
}

function runTournamentLoop(tournamentId, room) {
    const active = activeTournaments.get(tournamentId);
    if (!active) return;

    if (active.timerInterval) clearInterval(active.timerInterval);

    console.log(`[Timer] Iniciando loop para torneo ${tournamentId}`);

    active.timerInterval = setInterval(async () => {
        const state = calculateState(active.startTime, active.levels);

        if (!state) return; 

        // Caso: Terminado
        if (state.finished) {
            clearInterval(active.timerInterval);
            activeTournaments.delete(tournamentId);
            
            io.to(room).emit("tournament-control", { type: "finish" });
            
            try {
                await fetch(`${BACKEND_API}/${tournamentId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ Status: "Completed" })
                });
            } catch(e) { console.error("Error actualizando status FINISH a C#", e); }
            
            console.log(`[Timer] Torneo ${tournamentId} finalizado.`);
            return;
        }

        // Caso: Cambio de Nivel
        if (state.currentLevel !== active.cachedCurrentLevel) {
            console.log(`[Timer] Cambio de Nivel: ${active.cachedCurrentLevel} -> ${state.currentLevel}`);
            
            active.cachedCurrentLevel = state.currentLevel;

            io.to(room).emit("tournament-control", {
                type: "update-level",
                data: { level: state.currentLevel }
            });

            try {
                fetch(`${BACKEND_API}/${tournamentId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ CurrentLevel: state.currentLevel })
                });
            } catch(e) { console.error("Error patch level", e); }
        }

        // Caso: Tick normal
        io.to(room).emit("timer-sync", {
            currentLevel: state.currentLevel,
            timeLeft: state.timeRemaining,
            status: "Running" // Agregamos status explícito para ayudar al frontend
        });

    }, 1000);
}

// ==========================================
// 5. API HELPERS
// ==========================================

async function getTournamentFromApi(id) {
    try {
        const res = await fetch(`${BACKEND_API}/${id}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error("Error fetching API:", e);
        return null;
    }
}

async function startTournamentApi(id) {
    try {
        const res = await fetch(`${BACKEND_API}/${id}/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error("Error starting API:", e);
        return null;
    }
}

// ==========================================
// 6. SOCKET EVENTS
// ==========================================

io.on("connection", (socket) => {
    console.log(`[Connect] Cliente ${socket.id}`);

    socket.on("register-display", () => {
        const id = Math.random().toString(36).substring(2, 8).toUpperCase();
        displays.set(id, socket.id);
        socket.emit("display-id", id);
    });

    socket.on("link-display", ({ displayId, tournamentId }) => {
        const targetId = displays.get(displayId);
        if (targetId) {
            const target = io.sockets.sockets.get(targetId);
            if (target) {
                target.join(tournamentRoom(tournamentId));
                target.emit("display-linked", { tournamentId });
            }
        }
    });

    socket.on("join-tournament", async ({ tournamentId }) => {
        if (!tournamentId) return;
        const room = tournamentRoom(tournamentId);
        socket.join(room);

        let active = activeTournaments.get(tournamentId);

        // Recuperación (Resurrección) si Node se reinició pero C# dice que corre
        if (!active) {
            const t = await getTournamentFromApi(tournamentId);
            
            // Verificamos "Running" sin importar mayúsculas/minúsculas
            if (t && t.startTime && t.status && t.status.toLowerCase() === "running") {
                console.log(`[Recovery] Reviviendo torneo ${t.name}`);
                active = {
                    id: t.id,
                    startTime: t.startTime,
                    levels: t.levels || [],
                    cachedCurrentLevel: t.currentLevel,
                    timerInterval: null
                };
                activeTournaments.set(tournamentId, active);
                runTournamentLoop(tournamentId, room);
            }
        }

        if (active) {
            const currentState = calculateState(active.startTime, active.levels);
            if (currentState) {
                 socket.emit("tournament-control", { 
                    type: "update-level", 
                    data: { level: currentState.currentLevel } 
                });
                socket.emit("timer-sync", {
                    currentLevel: currentState.currentLevel,
                    timeLeft: currentState.timeRemaining,
                    status: "Running"
                });
            }
        }
    });

    socket.on("leave-tournament", ({ tournamentId }) => {
        if(tournamentId) socket.leave(tournamentRoom(tournamentId));
    });

    socket.on("tournament-control", async ({ tournamentId, type }) => {
        const room = tournamentRoom(tournamentId);
        
        if (type === "start") {
            console.log(`[Control] Start ${tournamentId}`);
            const updatedTournament = await startTournamentApi(tournamentId);

            if (updatedTournament) {
                const active = {
                    id: updatedTournament.id,
                    startTime: updatedTournament.startTime,
                    levels: updatedTournament.levels,
                    cachedCurrentLevel: 1,
                    timerInterval: null
                };
                activeTournaments.set(tournamentId, active);

                io.to(room).emit("tournament-control", { 
                    type: "start",
                    data: { level: 1 } 
                });

                runTournamentLoop(tournamentId, room);
            }
        }
        else if (type === "pause") {
            const active = activeTournaments.get(tournamentId);
            if (active) {
                if (active.timerInterval) clearInterval(active.timerInterval);
                activeTournaments.delete(tournamentId);
            }
            
            try {
                await fetch(`${BACKEND_API}/${tournamentId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ Status: "Paused" })
                });
            } catch(e) {}

            io.to(room).emit("tournament-control", { type: "pause" });
        }
    });

    // --- RELAY DE C# ---
    socket.on("player-action", ({ tournamentId, action, payload }) => {
        // Esto lo usabas antes cuando el front emitía. 
        // Ahora C# emite via webhook, pero dejamos esto por si acaso.
        socket.to(tournamentRoom(tournamentId)).emit("player-action", { action, payload });
    });
    
    socket.on("admin-instruction", ({ tournamentId, type, message, payload }) => {
        io.to(tournamentRoom(tournamentId)).emit("tournament-instruction", {
            type: type,
            message: message,
            payload: payload
        });
    });
});

// Importante: Escuchar en 0.0.0.0 para Render
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server Socket.io listo en puerto ${PORT}`);
});
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

// Middleware para JSON
app.use(express.json());

// 🔥 LOGGING HTTP (Ver tráfico de C#)
// Esto imprimirá cada vez que C# llame al Webhook
app.use((req, res, next) => {
    // Ignoramos la ruta raíz para no ensuciar el log con los Health Checks de Render
    if (req.path !== '/') {
        console.log(`📡 [HTTP INCOMING] ${req.method} ${req.path}`);
        if (req.method === 'POST') {
            console.log('   📦 Body:', JSON.stringify(req.body, null, 2));
        }
    }
    next();
});

// Ruta de Health Check (Vital para Render)
app.get('/', (req, res) => {
    res.status(200).send("Poker Socket Server is Running 🚀");
});

// URL Backend C#
const BACKEND_API = "https://pokergenysbackend.onrender.com/api/Tournaments";

const io = new Server(server, {
    cors: {
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
    const { tournamentId, event, data } = req.body;

    if (!tournamentId || !event) {
        console.warn("⚠️ [Webhook] Rechazado: Faltan datos", req.body);
        return res.status(400).send("Faltan datos");
    }

    const room = tournamentRoom(tournamentId);
    
    console.log(`📢 [Webhook Relay] C# dice: '${event}' -> Sala: ${room}`);
    
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
// 4. LÓGICA DE NEGOCIO
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

    console.log(`⏱️ [Timer] Loop INICIADO para ${tournamentId}`);

    active.timerInterval = setInterval(async () => {
        const state = calculateState(active.startTime, active.levels);

        if (!state) return; 

        // Caso: Terminado
        if (state.finished) {
            console.log(`🏁 [Timer] Torneo ${tournamentId} FINALIZADO`);
            clearInterval(active.timerInterval);
            activeTournaments.delete(tournamentId);
            
            io.to(room).emit("tournament-control", { type: "finish" });
            
            try {
                await fetch(`${BACKEND_API}/${tournamentId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ Status: "Completed" })
                });
            } catch(e) { console.error("❌ Error actualizando status FINISH a C#", e.message); }
            return;
        }

        // Caso: Cambio de Nivel
        if (state.currentLevel !== active.cachedCurrentLevel) {
            console.log(`🆙 [Timer] NIVEL UP: ${active.cachedCurrentLevel} -> ${state.currentLevel}`);
            
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
            } catch(e) { console.error("❌ Error patching level", e.message); }
        }

        // Caso: Tick normal
        // NOTA: Comentamos el log del tick para no saturar la consola de Render (1 log por segundo)
        // console.log(`tick ${state.timeRemaining}`); 
        io.to(room).emit("timer-sync", {
            currentLevel: state.currentLevel,
            timeLeft: state.timeRemaining,
            status: "Running"
        });

    }, 1000);
}

// ==========================================
// 5. API HELPERS
// ==========================================

async function getTournamentFromApi(id) {
    try {
        console.log(`🔍 [API] Fetching torneo ${id}...`);
        const res = await fetch(`${BACKEND_API}/${id}`);
        if (!res.ok) {
            console.error(`❌ [API] Error ${res.status} al obtener torneo`);
            return null;
        }
        return await res.json();
    } catch (e) {
        console.error("❌ [API] Excepción fetching:", e.message);
        return null;
    }
}

async function startTournamentApi(id) {
    try {
        console.log(`▶️ [API] Iniciando torneo ${id} en C#...`);
        const res = await fetch(`${BACKEND_API}/${id}/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
        if (!res.ok) {
            console.error(`❌ [API] Error ${res.status} al iniciar torneo`);
            return null;
        }
        return await res.json();
    } catch (e) {
        console.error("❌ [API] Excepción starting:", e.message);
        return null;
    }
}

// ==========================================
// 6. SOCKET EVENTS
// ==========================================

io.on("connection", (socket) => {
    console.log(`🔌 [Socket] Cliente Conectado: ${socket.id}`);

    // 🔥 LOGGING DE SOCKETS (Ver qué manda el cliente)
    socket.onAny((eventName, ...args) => {
        // Filtramos timer-sync si lo emitiese el cliente (raro) para no saturar
        if (eventName !== 'timer-sync') {
            console.log(`📨 [Socket IN] Evento: "${eventName}"`, args);
        }
    });

    socket.on("register-display", () => {
        const id = Math.random().toString(36).substring(2, 8).toUpperCase();
        displays.set(id, socket.id);
        socket.emit("display-id", id);
        console.log(`📺 [Display] Registrada TV con código: ${id}`);
    });

    socket.on("link-display", ({ displayId, tournamentId }) => {
        const targetId = displays.get(displayId);
        if (targetId) {
            const target = io.sockets.sockets.get(targetId);
            if (target) {
                target.join(tournamentRoom(tournamentId));
                target.emit("display-linked", { tournamentId });
                console.log(`🔗 [Link] TV ${displayId} vinculada a torneo ${tournamentId}`);
            }
        } else {
            console.warn(`⚠️ [Link] Intento fallido: Display ID ${displayId} no encontrado`);
        }
    });

    socket.on("join-tournament", async ({ tournamentId }) => {
        if (!tournamentId) return;
        const room = tournamentRoom(tournamentId);
        socket.join(room);
        console.log(`👤 [Join] Cliente ${socket.id} se unió a sala ${room}`);

        let active = activeTournaments.get(tournamentId);

        // Recuperación
        if (!active) {
            const t = await getTournamentFromApi(tournamentId);
            if (t && t.startTime && t.status && t.status.toLowerCase() === "running") {
                console.log(`♻️ [Recovery] Reviviendo torneo activo ${t.name}`);
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
        console.log(`🎮 [Control] Comando recibido: ${type} para ${tournamentId}`);
        
        if (type === "start") {
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

    // --- RELAYS ---
    socket.on("player-action", ({ tournamentId, action, payload }) => {
        socket.to(tournamentRoom(tournamentId)).emit("player-action", { action, payload });
    });
    
    socket.on("admin-instruction", ({ tournamentId, type, message, payload }) => {
        io.to(tournamentRoom(tournamentId)).emit("tournament-instruction", {
            type: type,
            message: message,
            payload: payload
        });
    });

    socket.on("disconnect", (reason) => {
        // console.log(`❌ [Socket] Cliente desconectado: ${reason}`); // Descomentar si quieres ver desconexiones
    });
});

// Importante: Escuchar en 0.0.0.0 para Render
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server Socket.io LISTO en puerto ${PORT}`);
    console.log(`🌍 Health Check disponible en GET /`);
    console.log(`🔗 Webhook disponible en POST /api/webhook/emit`);
});
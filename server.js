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
app.use((req, res, next) => {
    if (req.path !== '/') {
        console.log(`📡 [HTTP INCOMING] ${req.method} ${req.path}`);
        if (req.method === 'POST') {
            // Logueamos solo un resumen para no saturar la consola si el body es gigante
            const bodyPreview = JSON.stringify(req.body).substring(0, 200);
            console.log(`   📦 Body: ${bodyPreview}...`);
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
        // Permitimos cualquier origen para evitar bloqueos CORS en producción
        // Puedes restringirlo a tus dominios reales si lo prefieres
        origin: "*", 
        methods: ["GET", "POST"],
        credentials: true
    },
    // 🔥 CONFIGURACIÓN CRÍTICA PARA RENDER 🔥
    // Render usa balanceadores de carga que rompen el HTTP Long-Polling si no hay Sticky Sessions.
    // Al permitir y priorizar 'websocket', reducimos errores de transporte.
    transports: ["websocket", "polling"], 
    
    // Tiempos de espera extendidos para evitar desconexiones fantasma
    pingTimeout: 60000, 
    pingInterval: 25000 
});

// ==========================================
// 2. ESTADO EN MEMORIA Y UTILIDADES
// ==========================================
const activeTournaments = new Map();
const displays = new Map();
const tournamentRoom = (id) => `tournament:${id}`;

// Lógica del Timer (Motor de Tiempo)
function calculateState(startTimeStr, levels) {
    if (!startTimeStr || !levels || levels.length === 0) return null;

    const now = Date.now();
    const startTime = new Date(startTimeStr).getTime(); 
    const elapsedMs = Math.max(0, now - startTime); // Evitar negativos

    let levelStartMs = 0;
    // Ordenar niveles por seguridad
    const sortedLevels = levels.sort((a, b) => a.levelNumber - b.levelNumber);

    for (let i = 0; i < sortedLevels.length; i++) {
        const lvl = sortedLevels[i];
        const durationMs = lvl.durationSeconds * 1000;
        const levelEndMs = levelStartMs + durationMs;

        // Estamos dentro de este nivel
        if (elapsedMs < levelEndMs) {
            const timeRemainingSeconds = Math.ceil((levelEndMs - elapsedMs) / 1000);
            return {
                finished: false,
                currentLevel: lvl.levelNumber,
                timeRemaining: timeRemainingSeconds
            };
        }
        levelStartMs += durationMs;
    }

    return { finished: true, currentLevel: sortedLevels.length, timeRemaining: 0 };
}

function runTournamentLoop(tournamentId, ioInstance) { 
    // Si ya existe un loop activo, lo reutilizamos o reiniciamos limpiamente
    let active = activeTournaments.get(tournamentId);
    if (!active) return;

    if (active.timerInterval) clearInterval(active.timerInterval);

    console.log(`⏱️ [Timer] Loop INICIADO para ${tournamentId}`);

    active.timerInterval = setInterval(async () => {
        // Recalcular estado basado en StartTime (Fuente de la verdad)
        const state = calculateState(active.startTime, active.levels);

        if (!state) return; 

        const room = tournamentRoom(tournamentId);

        // 1. Caso: Finalizado
        if (state.finished) {
            console.log(`🏁 [Timer] Torneo ${tournamentId} FINALIZADO`);
            clearInterval(active.timerInterval);
            activeTournaments.delete(tournamentId);
            
            ioInstance.to(room).emit("tournament-control", { type: "finish" });
            
            // Avisar a C# que terminó (Fire & Forget)
            try {
                fetch(`${BACKEND_API}/${tournamentId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ Status: "Completed" })
                }).catch(e => console.error("Error patching finish:", e.message));
            } catch(e) {}
            return;
        }

        // 2. Caso: Cambio de Nivel
        if (state.currentLevel !== active.cachedCurrentLevel) {
            console.log(`🆙 [Timer] NIVEL UP: ${active.cachedCurrentLevel} -> ${state.currentLevel}`);
            active.cachedCurrentLevel = state.currentLevel;

            ioInstance.to(room).emit("tournament-control", {
                type: "update-level",
                data: { level: state.currentLevel }
            });

            // Persistir nivel en C#
            try {
                fetch(`${BACKEND_API}/${tournamentId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ CurrentLevel: state.currentLevel })
                }).catch(e => console.error("Error patching level:", e.message));
            } catch(e) {}
        }

        // 3. Caso: Tick Normal (Heartbeat)
        ioInstance.to(room).emit("timer-sync", {
            currentLevel: state.currentLevel,
            timeLeft: state.timeRemaining,
            status: "Running"
        });

    }, 1000);
    
    // Guardamos la referencia actualizada con el intervalo
    activeTournaments.set(tournamentId, active);
}

// ... (Helpers de API: getTournamentFromApi se mantiene igual si lo tenías definido abajo, 
// si no, asegúrate de incluirlo. Aquí asumo que ya lo tienes o lo necesitas) ...

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

// ==========================================
// 3. WEBHOOK (Comunicación C# -> Node)
// ==========================================
app.post('/api/webhook/emit', (req, res) => {
    const { tournamentId, event, data } = req.body;

    if (!tournamentId || !event) {
        console.warn("⚠️ [Webhook] Rechazado: Faltan datos", req.body);
        return res.status(400).send("Faltan datos");
    }

    const room = tournamentRoom(tournamentId);
    
    // A. Broadcast inmediato a los clientes (TVs/Admins)
    io.to(room).emit(event, data);
    console.log(`📢 [Broadcast] ${event} -> ${room}`);

    // B. INTERCEPTAR COMANDOS DE CONTROL (La corrección clave para que arranque el reloj)
    if (event === "tournament-control") {
        
        // --- START / RESUME ---
        if (data.type === "start" || data.type === "resume") {
            // Si C# nos envió el estado interno (_internalState), lo usamos para iniciar YA.
            if (req.body.data?._internalState) {
                const internal = req.body.data._internalState;
                console.log(`⚡ [Webhook] Iniciando Loop Interno con datos inyectados para ${tournamentId}`);
                
                const active = {
                    id: tournamentId,
                    startTime: internal.startTime,
                    levels: internal.levels || [],
                    cachedCurrentLevel: internal.currentLevel,
                    timerInterval: null
                };
                activeTournaments.set(tournamentId, active);
                runTournamentLoop(tournamentId, io);
            } 
            // Fallback: Si C# no mandó estado (versión vieja), intentar recuperar
            else if (!activeTournaments.has(tournamentId)) {
                getTournamentFromApi(tournamentId).then(t => {
                    if (t && t.startTime) {
                        activeTournaments.set(tournamentId, {
                            id: t.id,
                            startTime: t.startTime,
                            levels: t.levels,
                            cachedCurrentLevel: t.currentLevel,
                            timerInterval: null
                        });
                        runTournamentLoop(tournamentId, io);
                    }
                });
            }
        }
        
        // --- PAUSE / FINISH ---
        else if (data.type === "pause" || data.type === "finish") {
            console.log(`⏸️ [Webhook] Deteniendo Loop Interno para ${tournamentId}`);
            const active = activeTournaments.get(tournamentId);
            if (active && active.timerInterval) {
                clearInterval(active.timerInterval);
                activeTournaments.delete(tournamentId); // Limpiar memoria
            }
        }
    }

    res.status(200).send({ success: true });
});

// ==========================================
// 4. SOCKET EVENTS
// ==========================================
io.on("connection", (socket) => {
    
    // A. GESTIÓN DE PANTALLAS (TV PAIRING)
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

    // B. UNIRSE A TORNEO
    socket.on("join-tournament", async ({ tournamentId }) => {
        if (!tournamentId) return;
        const room = tournamentRoom(tournamentId);
        socket.join(room);
        console.log(`👤 [Join] Cliente ${socket.id} se unió a sala ${room}`);
        
        // RECUPERACIÓN INTELIGENTE
        // Si el cliente se conecta y Node NO tiene el torneo corriendo en memoria (ej. tras reinicio),
        // verificamos con la API por si acaso el torneo sigue "Running" en BD.
        let active = activeTournaments.get(tournamentId);

        if (!active) {
            const t = await getTournamentFromApi(tournamentId);
            // Solo revivimos si el status en BD es "Running" y tiene StartTime
            if (t && t.startTime && t.status === "Running") {
                console.log(`♻️ [Recovery] Restaurando torneo ${t.name} desde API`);
                active = {
                    id: t.id,
                    startTime: t.startTime,
                    levels: t.levels || [],
                    cachedCurrentLevel: t.currentLevel,
                    timerInterval: null
                };
                activeTournaments.set(tournamentId, active);
                runTournamentLoop(tournamentId, io);
            }
        }

        // Si logramos recuperar o ya estaba activo, sincronizamos al cliente inmediatamente
        if (active) {
            const currentState = calculateState(active.startTime, active.levels);
            if (currentState && !currentState.finished) {
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

    socket.on("disconnect", (reason) => {
        // Cliente desconectado
    });
});

// Importante: Escuchar en 0.0.0.0 para Render
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server Socket.io LISTO en puerto ${PORT}`);
    console.log(`🌍 Health Check disponible en GET /`);
    console.log(`🔗 Webhook disponible en POST /api/webhook/emit`);
});
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

// URL Backend C#
const BACKEND_API = "https://pokergenysbackend.onrender.com/api/Tournaments";

app.use(express.json());

// Logging HTTP para depuración
app.use((req, res, next) => {
    if (req.path !== '/') {
        // Logueamos solo un resumen para no saturar
        if (req.method === 'POST') {
            console.log(`📨 [Webhook] ${req.path}`, JSON.stringify(req.body).substring(0, 150) + "...");
        }
    }
    next();
});

app.get('/', (req, res) => res.status(200).send("Poker Socket Server is Running 🚀"));

const io = new Server(server, {
    cors: {
        origin: "*", // Permisivo para evitar problemas de conexión inicial
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ["websocket", "polling"], 
    
    // 🔥 CONFIGURACIÓN CRÍTICA PARA RENDER 🔥
    // Evita el error "transport close" y mantiene el reloj vivo
    pingTimeout: 60000, 
    pingInterval: 25000 
});

// ==========================================
// 2. MOTOR DE TIEMPO (TIMER ENGINE)
// ==========================================
const activeTournaments = new Map();
const displays = new Map();
const tournamentRoom = (id) => `tournament:${id}`;

function runTournamentLoop(tournamentId, ioInstance) { 
    // Gestión de singleton: si ya existe, lo limpiamos para reiniciar
    let active = activeTournaments.get(tournamentId);
    if (!active) return;

    if (active.timerInterval) clearInterval(active.timerInterval);

    console.log(`⏱️ [Timer] Loop INICIADO para ${tournamentId}. Meta Absoluta: ${active.targetEndTime}`);

    active.timerInterval = setInterval(() => {
        const now = Date.now();
        const target = new Date(active.targetEndTime).getTime();
        
        // Calculamos diferencia contra la meta absoluta
        const diff = target - now;
        const secondsLeft = Math.max(0, Math.ceil(diff / 1000));

        // 1. Caso: Se acabó el tiempo del nivel
        if (secondsLeft <= 0) {
            clearInterval(active.timerInterval);
            ioInstance.to(tournamentRoom(tournamentId)).emit("timer-sync", {
                currentLevel: active.currentLevel,
                timeLeft: 0,
                status: "Paused" // Pausamos visualmente en 0
            });
            return;
        }

        // 2. Heartbeat normal (Tick)
        ioInstance.to(tournamentRoom(tournamentId)).emit("timer-sync", {
            currentLevel: active.currentLevel,
            timeLeft: secondsLeft,
            status: "Running"
        });

    }, 1000);
    
    activeTournaments.set(tournamentId, active);
}

// Helper para recuperar datos de C# si Node se reinicia
async function getTournamentFromApi(id) {
    try {
        const res = await fetch(`${BACKEND_API}/${id}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error("❌ Error API:", e.message);
        return null;
    }
}

// ==========================================
// 3. WEBHOOK (Recibe órdenes de C#)
// ==========================================
app.post('/api/webhook/emit', (req, res) => {
    const { tournamentId, event, data } = req.body;

    if (!tournamentId || !event) return res.status(400).send("Faltan datos");

    const room = tournamentRoom(tournamentId);
    
    // A. Broadcast inmediato (Acciones de jugadores, alertas, etc.)
    io.to(room).emit(event, data);
    console.log(`📢 [Broadcast] ${event} -> Sala ${room}`);

    // B. Interceptar Control de Torneo (Start/Pause/Finish)
    if (event === "tournament-control") {
        
        // INICIO / RESUME
        if (data.type === "start" || data.type === "resume") {
            // Usamos los datos inyectados por C# (StartTournamentAsync)
            if (req.body.data?._internalState) {
                const internal = req.body.data._internalState;
                
                const active = {
                    id: tournamentId,
                    targetEndTime: internal.targetEndTime, // La clave: C# calcula cuándo termina
                    currentLevel: internal.currentLevel,
                    timerInterval: null
                };
                
                activeTournaments.set(tournamentId, active);
                runTournamentLoop(tournamentId, io);
            } 
        }
        
        // PAUSA / FIN
        else if (data.type === "pause" || data.type === "finish") {
            console.log(`⏸️ [Control] Deteniendo reloj para ${tournamentId}`);
            const active = activeTournaments.get(tournamentId);
            if (active && active.timerInterval) {
                clearInterval(active.timerInterval);
                activeTournaments.delete(tournamentId);
            }
        }
    }

    res.status(200).send({ success: true });
});

// ==========================================
// 4. SOCKET EVENTS
// ==========================================
io.on("connection", (socket) => {
    
    // Pairing de Pantallas
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

    // Unirse a Sala de Torneo
    socket.on("join-tournament", async ({ tournamentId }) => {
        if (!tournamentId) return;
        const room = tournamentRoom(tournamentId);
        socket.join(room);
        
        // --- LÓGICA DE RECUPERACIÓN ---
        // Si el cliente se conecta y Node NO tiene el reloj corriendo (ej. reinicio de server),
        // preguntamos a C# si el torneo debería estar corriendo.
        let active = activeTournaments.get(tournamentId);

        if (!active) {
            const t = await getTournamentFromApi(tournamentId);
            // Si en BD dice "Running", recalculamos la meta
            if (t && t.startTime && t.status === "Running") {
                console.log(`♻️ [Recovery] Restaurando torneo activo ${t.name}`);
                
                // Calcular tiempo restante basado en lógica de recuperación
                // Nota: Esto es un fallback. Lo ideal es que C# mande el webhook, 
                // pero esto salva si se reinicia el pod de Render.
                
                // Buscar duración nivel actual
                const currentLvl = t.levels.find(l => l.levelNumber === t.currentLevel);
                const duration = currentLvl ? currentLvl.durationSeconds : 0;
                
                // Reconstruir targetEndTime basado en StartTime de BD (que C# ajusta al pausar/resumir)
                const start = new Date(t.startTime).getTime();
                // Asumimos que start + duration es el final (aproximación para recovery)
                // O mejor: Calculamos el targetEndTime con la info que tenemos
                
                // NOTA: Para recovery perfecto, active.targetEndTime debería guardarse en Redis, 
                // pero por ahora usamos el StartTime ajustado de C# como base.
                const targetTimeRecovery = new Date(start + (duration * 1000)).toISOString();

                active = {
                    id: t.id,
                    targetEndTime: targetTimeRecovery,
                    currentLevel: t.currentLevel,
                    timerInterval: null
                };
                activeTournaments.set(tournamentId, active);
                runTournamentLoop(tournamentId, io);
            }
        }

        // Sincronización inmediata al conectar (Snap)
        if (active) {
            const now = Date.now();
            const target = new Date(active.targetEndTime).getTime();
            const seconds = Math.max(0, Math.ceil((target - now)/1000));
            
            socket.emit("timer-sync", {
                currentLevel: active.currentLevel,
                timeLeft: seconds,
                status: "Running"
            });
        }
    });

    socket.on("leave-tournament", ({ tournamentId }) => {
        if(tournamentId) socket.leave(tournamentRoom(tournamentId));
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server Socket.io LISTO en puerto ${PORT}`);
});
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

// URL de tu Backend C# (Asegúrate de que esta URL sea accesible desde el servidor Node)
const BACKEND_API = "https://pokergenysbackend.onrender.com/api/Tournaments";

const io = new Server(server, {
  cors: {
    origin: ["https://pokergenys.netlify.app", "http://localhost:5173"], // Tus frontends
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"]
});

// ==========================================
// 2. ESTADO EN MEMORIA
// ==========================================
// Guardamos aquí los torneos activos para no consultar la API 1000 veces por segundo.
// Estructura: { id, startTime (timestamp), levels: [], currentLevelIndex, timerInterval }
const activeTournaments = new Map();

const tournamentRoom = (id) => `tournament:${id}`;
const displays = new Map();

// ==========================================
// 3. LÓGICA DE NEGOCIO (REPLICA DE C#)
// ==========================================

/**
 * Calcula el estado actual (Nivel y Tiempo Restante) basándose en StartTime.
 * Esta función es una COPIA EXACTA de tu lógica C# GetTournamentStateAsync
 * para asegurar que Node.js y C# siempre digan lo mismo.
 */
function calculateState(startTimeStr, levels) {
    if (!startTimeStr || !levels || levels.length === 0) return null;

    const now = Date.now();
    // Convertimos la fecha de C# a Timestamp de JS.
    // Asegúrate de que C# envíe formato ISO UTC (ej: 2023-10-25T14:00:00Z)
    const startTime = new Date(startTimeStr).getTime(); 
    
    // Tiempo transcurrido en milisegundos
    const elapsedMs = now - startTime;

    let levelIndex = 0; // 0-based index para el array levels
    let levelStartMs = 0;
    let timeRemainingSeconds = 0;
    let found = false;

    // Ordenar niveles por si acaso (igual que tu OrderBy)
    const sortedLevels = levels.sort((a, b) => a.levelNumber - b.levelNumber);

    for (let i = 0; i < sortedLevels.length; i++) {
        const lvl = sortedLevels[i];
        const durationMs = lvl.durationSeconds * 1000;

        // Si el tiempo transcurrido es menor que el fin de este nivel, estamos aquí.
        if (elapsedMs < (levelStartMs + durationMs)) {
            // C# Logic: timeRemaining = (levelStartMs + durationMs - elapsedMs) / 1000
            timeRemainingSeconds = (levelStartMs + durationMs - elapsedMs) / 1000;
            levelIndex = i;
            found = true;
            break;
        }

        levelStartMs += durationMs;
    }

    // Si nos pasamos del último nivel, el torneo acabó
    if (!found) {
        return { finished: true, currentLevel: sortedLevels.length + 1, timeRemaining: 0 };
    }

    return {
        finished: false,
        currentLevel: sortedLevels[levelIndex].levelNumber, // El numero real (ej: 1, 2, 3)
        timeRemaining: Math.ceil(timeRemainingSeconds)
    };
}

/**
 * Función principal que corre cada segundo para un torneo activo.
 */
function runTournamentLoop(tournamentId, room) {
    const active = activeTournaments.get(tournamentId);
    if (!active) return;

    // Limpiamos intervalo anterior si existe para evitar duplicados
    if (active.timerInterval) clearInterval(active.timerInterval);

    console.log(`[Timer] Iniciando loop para torneo ${tournamentId} (Start: ${active.startTime})`);

    active.timerInterval = setInterval(async () => {
        // 1. Calcular estado localmente (Matemática pura, muy rápido)
        const state = calculateState(active.startTime, active.levels);

        if (!state) return; // Algo anda mal con los datos

        // Caso: Torneo Terminado
        if (state.finished) {
            clearInterval(active.timerInterval);
            activeTournaments.delete(tournamentId);
            
            io.to(room).emit("tournament-control", { type: "finish" });
            
            // Actualizar C# a 'Completed'
            await fetch(`${BACKEND_API}/${tournamentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ Status: "Completed" })
            });
            console.log(`[Timer] Torneo ${tournamentId} finalizado.`);
            return;
        }

        // Caso: Cambio de Nivel detectado
        if (state.currentLevel !== active.cachedCurrentLevel) {
            console.log(`[Timer] Cambio de Nivel detectado: ${active.cachedCurrentLevel} -> ${state.currentLevel}`);
            
            active.cachedCurrentLevel = state.currentLevel;

            // A) Notificar Clientes (Evento de cambio fuerte)
            io.to(room).emit("tournament-control", {
                type: "update-level",
                data: { level: state.currentLevel }
            });

            // B) Sincronizar C# (Para persistencia)
            // Tu API Patch permite actualizar CurrentLevel
            fetch(`${BACKEND_API}/${tournamentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ CurrentLevel: state.currentLevel })
            }).catch(e => console.error("Error patching level:", e));
        }

        // Caso: Tick normal (Sincronización de reloj)
        // Enviamos esto cada segundo para que los clientes vean el tiempo real calculado desde el servidor
        io.to(room).emit("timer-sync", {
            currentLevel: state.currentLevel,
            timeLeft: state.timeRemaining // 'timeLeft' es lo que espera tu hook de frontend
        });

    }, 1000);
}

// ==========================================
// 4. API HELPERS
// ==========================================

// Recupera datos completos del torneo desde C#
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

// Llama al endpoint C# [HttpPost("{id}/start")]
async function startTournamentApi(id) {
    try {
        const res = await fetch(`${BACKEND_API}/${id}/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
        });
        if (!res.ok) return null;
        return await res.json(); // Devuelve el torneo actualizado con StartTime
    } catch (e) {
        console.error("Error starting API:", e);
        return null;
    }
}

// ==========================================
// 5. SOCKET EVENTS
// ==========================================

io.on("connection", (socket) => {
    console.log(`[Connect] Cliente ${socket.id}`);

    // --- DISPLAYS ---
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

    // --- LOGICA DE JOIN / RECUPERACIÓN ---
    socket.on("join-tournament", async ({ tournamentId }) => {
        if (!tournamentId) return;
        const room = tournamentRoom(tournamentId);
        socket.join(room);

        // 1. Ver si ya lo estamos corriendo en memoria
        let active = activeTournaments.get(tournamentId);

        // 2. Si NO está en memoria, preguntar a la API (Resurrección)
        if (!active) {
            const t = await getTournamentFromApi(tournamentId);
            
            // Si tiene StartTime y Status Running, hay que revivirlo
            if (t && t.startTime && t.status === "Running") {
                console.log(`[Recovery] Reviviendo torneo ${t.name}`);
                active = {
                    id: t.id,
                    startTime: t.startTime, // String ISO
                    levels: t.levels || [],
                    cachedCurrentLevel: t.currentLevel,
                    timerInterval: null
                };
                activeTournaments.set(tournamentId, active);
                runTournamentLoop(tournamentId, room);
            }
        }

        // 3. Enviar estado inmediato al que entró
        if (active) {
            const currentState = calculateState(active.startTime, active.levels);
            if (currentState) {
                 socket.emit("tournament-control", { 
                    type: "update-level", 
                    data: { level: currentState.currentLevel }
                });
                socket.emit("timer-sync", {
                    currentLevel: currentState.currentLevel,
                    timeLeft: currentState.timeRemaining
                });
            }
        }
    });

    socket.on("leave-tournament", ({ tournamentId }) => {
        if(tournamentId) socket.leave(tournamentRoom(tournamentId));
    });

    // --- COMANDOS DE CONTROL (START/PAUSE) ---
    socket.on("tournament-control", async ({ tournamentId, type }) => {
        const room = tournamentRoom(tournamentId);
        
        // START
        if (type === "start") {
            console.log(`[Control] Iniciando torneo ${tournamentId} via API`);
            
            // 1. Llamar a C# para que ponga el StartTime y Status = Running
            const updatedTournament = await startTournamentApi(tournamentId);

            if (updatedTournament) {
                // 2. Guardar en memoria de Node
                const active = {
                    id: updatedTournament.id,
                    startTime: updatedTournament.startTime, // C# devolvió el StartTime fresco
                    levels: updatedTournament.levels,
                    cachedCurrentLevel: 1,
                    timerInterval: null
                };
                activeTournaments.set(tournamentId, active);

                // 3. Notificar a todos
                io.to(room).emit("tournament-control", { 
                    type: "start",
                    data: { level: 1 } 
                });

                // 4. Arrancar el loop de cálculo
                runTournamentLoop(tournamentId, room);
            }
        }

        // PAUSE
        // NOTA: Con la lógica de StartTime, "Pausar" es complejo porque el tiempo real sigue corriendo.
        // Lo habitual es guardar un "PauseDuration" en BD.
        // Por ahora, solo enviaremos el evento visual y pararemos el loop de Node.
        // (Pero ten en cuenta que C# GetState seguirá avanzando a menos que implementes pausa en C#)
        else if (type === "pause") {
            const active = activeTournaments.get(tournamentId);
            if (active) {
                if (active.timerInterval) clearInterval(active.timerInterval);
                activeTournaments.delete(tournamentId); // Lo sacamos de memoria para que deje de emitir
            }
            
            // Actualizar estado en C#
            await fetch(`${BACKEND_API}/${tournamentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ Status: "Paused" })
            });

            io.to(room).emit("tournament-control", { type: "pause" });
        }
    });

    // --- JUGADORES (Relay) ---
    socket.on("player-action", ({ tournamentId, action, payload }) => {
        socket.to(tournamentRoom(tournamentId)).emit("player-action", { action, payload });
    });
	
	// Agrega esto debajo de tus otros eventos
	socket.on("admin-instruction", ({ tournamentId, type, message, payload }) => {
		console.log(`[Instruction] Torneo ${tournamentId}: ${type} - ${message}`);
		
		// Emitir a la sala del torneo (TVs y otros admins)
		io.to(tournamentRoom(tournamentId)).emit("tournament-instruction", {
			type: type,      // Ej: "BALANCE_REQUIRED" o "FINAL_TABLE"
			message: message, // Ej: "Mover jugador de Mesa 1 a Mesa 3"
			payload: payload  // Datos extra (IDs de mesas, asientos)
		});
	});
});

server.listen(PORT, () => {
    console.log(`✅ Server Socket.io listo en puerto ${PORT}`);
    console.log(`🔗 Conectado a Backend C#: ${BACKEND_API}`);
});
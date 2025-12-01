import express from "express";
import http from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";

// ✅ Express básico
const app = express();
const server = http.createServer(app);

app.get("/", (req, res) => {
  res.send("Socket.io server running ✅");
});

// ----------------- HELPERS -----------------
function tournamentRoom(tournamentId: string) {
  return `tournament:${tournamentId}`;
}

function generateDisplayId() {
  return Math.random().toString(36).substring(2, 10);
}

// ----------------- TORNEOS EN MEMORIA -----------------
interface ActiveTournament {
  tournamentId: string;
  currentLevel: number;
  levelStartTimestamp: number;
  levels: { levelNumber: number; durationSeconds: number }[];
  timerInterval?: NodeJS.Timer;
}

const activeTournaments = new Map<string, ActiveTournament>();

// ✅ Configuración Socket.io
const io = new Server(server, {
  cors: {
    origin: [
      "https://pokergenys.netlify.app",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"]
});

// ----------------- MAPPING DISPLAYID -> SOCKET -----------------
const displays = new Map<string, string>();

// ----------------- SOCKET EVENTS -----------------
io.on("connection", (socket) => {
  console.log("[Socket.IO] Nuevo cliente conectado:", socket.id);

  // Log de todos los eventos para debug
  socket.onAny((event, payload) => {
    console.log(`[Socket.IO] Evento recibido: ${event}`, payload);
  });

  // ----------------- REGISTRAR PANTALLA -----------------
  socket.on("register-display", () => {
    const displayId = generateDisplayId();
    displays.set(displayId, socket.id);
    socket.emit("display-id", displayId);
    console.log(`[Socket.IO] Asignando displayId ${displayId} a socket ${socket.id}`);
  });

  // ----------------- LINK DISPLAY -----------------
  socket.on("link-display", ({ displayId, tournamentId }) => {
    const targetSocketId = displays.get(displayId);
    if (!targetSocketId) return console.warn(`[Socket.IO] DisplayId ${displayId} no encontrado`);

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return console.warn(`[Socket.IO] No se encontró targetSocket por id: ${targetSocketId}`);

    const room = tournamentRoom(tournamentId);
    targetSocket.join(room);
    targetSocket.emit("display-linked", { tournamentId });
    console.log(`[Socket.IO] Display ${displayId} unido a room ${room}`);
  });

  // ----------------- JOIN / LEAVE TOURNAMENT -----------------
  socket.on("join-tournament", ({ tournamentId }) => {
    const room = tournamentRoom(tournamentId);
    socket.join(room);
    console.log(`[Socket.IO] Socket ${socket.id} joined room ${room}`);

    // Si torneo activo, enviar estado actual al display
    const active = activeTournaments.get(tournamentId);
    if (active) {
      socket.emit("tournament-control", {
        type: "update-level",
        data: {
          level: active.currentLevel,
          levelStartTimestamp: active.levelStartTimestamp
        }
      });
    }
  });

  socket.on("leave-tournament", ({ tournamentId }) => {
    const room = tournamentRoom(tournamentId);
    socket.leave(room);
    console.log(`[Socket.IO] Socket ${socket.id} left room ${room}`);
  });

  // ----------------- PLAYER ACTIONS -----------------
  socket.on("player-action", ({ tournamentId, action, payload }) => {
    const room = tournamentRoom(tournamentId);
    io.to(room).emit("player-action", { action, payload });
    console.log(`[Socket.IO] player-action emitido en room ${room}:`, { action, payload });
  });

  // ----------------- ENVIAR DATOS MANUAL -----------------
  socket.on("send-tournament-data", (tournamentData) => {
    io.emit("tournament-data", tournamentData);
    console.log("[Socket.IO] Enviando tournament-data a todos los displays:", tournamentData);
  });

  // ----------------- CONTROL TORNEO: PAUSE / RESUME / START -----------------
  socket.on("tournament-control", async ({ tournamentId, type, data }) => {
    const room = tournamentRoom(tournamentId);
    const active = activeTournaments.get(tournamentId);

    console.log(`[Socket.IO] tournament-control -> type=${type}, tournamentId=${tournamentId}`);

    if (type === "pause" && active?.timerInterval) {
      clearInterval(active.timerInterval);
      io.to(room).emit("tournament-control", { type: "pause" });
    } 
    else if (type === "resume" && active) {
      active.levelStartTimestamp = Date.now();
      startTournamentTimer(active, room);
      io.to(room).emit("tournament-control", { type: "resume" });
    } 
    else if (type === "start" && data?.levels) {
      if (activeTournaments.has(tournamentId)) return;
      const levels = data.levels.map((lvl: any) => ({
        levelNumber: lvl.levelNumber,
        durationSeconds: lvl.durationSeconds
      }));
      const newActive: ActiveTournament = {
        tournamentId,
        currentLevel: 1,
        levelStartTimestamp: Date.now(),
        levels
      };
      activeTournaments.set(tournamentId, newActive);
      io.to(room).emit("tournament-control", {
        type: "update-level",
        data: { level: 1, levelStartTimestamp: newActive.levelStartTimestamp }
      });
      startTournamentTimer(newActive, room);
    } 
    else {
      io.to(room).emit("tournament-control", { type, data });
    }
  });

  // ----------------- DESCONECT -----------------
  socket.on("disconnect", () => {
    console.log("[Socket.IO] Cliente desconectado:", socket.id);
    for (const [id, sId] of displays.entries()) {
      if (sId === socket.id) {
        displays.delete(id);
        console.log(`[Socket.IO] DisplayId ${id} eliminado del mapping`);
        break;
      }
    }
  });
});

// ----------------- FUNCIONES AUXILIARES -----------------
function startTournamentTimer(active: ActiveTournament, room: string) {
  if (active.timerInterval) clearInterval(active.timerInterval);

  active.timerInterval = setInterval(() => {
    const now = Date.now();
    const currentLvl = active.levels[active.currentLevel - 1];
    const elapsed = Math.floor((now - active.levelStartTimestamp) / 1000);

    if (elapsed >= (currentLvl?.durationSeconds ?? 0)) {
      if (active.currentLevel < active.levels.length) {
        active.currentLevel++;
        active.levelStartTimestamp = Date.now();

        io.to(room).emit("tournament-control", {
          type: "update-level",
          data: { level: active.currentLevel, levelStartTimestamp: active.levelStartTimestamp }
        });

        // Persistir en backend
        fetch(`https://pokergenysbackend.onrender.com/api/tournaments/${active.tournamentId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentLevel: active.currentLevel })
        }).catch(console.error);

        console.log(`[Socket.IO] Torneo ${active.tournamentId} subió a nivel ${active.currentLevel}`);
      } else {
        clearInterval(active.timerInterval);
        activeTournaments.delete(active.tournamentId);
        io.to(room).emit("tournament-control", { type: "finish" });
        console.log(`[Socket.IO] Torneo ${active.tournamentId} terminado`);
      }
    }
  }, 1000);
}

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});

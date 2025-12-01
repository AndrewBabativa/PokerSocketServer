import express from "express";
import http from "http";
import { Server } from "socket.io";

// ✅ Express básico
const app = express();
const server = http.createServer(app);

app.get("/", (req, res) => {
  res.send("Socket.io server running ✅");
});

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
const displays = new Map(); // ⚠ JS puro, no <string,string>

// ----------------- SOCKET EVENTS -----------------
io.on("connection", (socket) => {
  console.log("Nuevo cliente conectado:", socket.id);

  // Registrar pantalla pública
  socket.on("register-display", () => {
    const displayId = generateDisplayId();
    console.log(`Asignando displayId ${displayId} a socket ${socket.id}`);
    displays.set(displayId, socket.id);
    socket.emit("display-id", displayId);
  });

  // Linkear torneo
    socket.on("link-display", async ({ displayId, tournamentId }) => {
    console.log(`Link-display -> displayId=${displayId}, tournamentId=${tournamentId}`);
    const targetSocketId = displays.get(displayId);
    if (targetSocketId) {
      // Hacer que el socket del display entre a una room para ese torneo
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.join(`tournament:${tournamentId}`);
        // emitir evento de confirmación con tournamentId
        targetSocket.emit("display-linked", { tournamentId });
        console.log(`Evento display-linked enviado a socket ${targetSocketId}`);

        // opcional: obtener estado del torneo y enviarlo
        try {
          const tournament = await getTournamentById(tournamentId); // implementa/ajusta esta función
          if (tournament) {
            targetSocket.emit("tournament-data", tournament);
          }
        } catch (err) {
          console.warn("No pude obtener tournament-data:", err);
        }
      } else {
        console.warn("No se encontró targetSocket por id:", targetSocketId);
      }
    } else {
      console.warn(`DisplayId ${displayId} no encontrado`);
    }
  });

  // admin -> server: acciones
  socket.on("player-action", async (payload) => {
    // valida y aplica cambios en DB
    const result = await applyPlayerAction(payload);
    // emitir a la room del torneo para que todos los displays lo reciban
    io.to(`tournament:${payload.tournamentId}`).emit("player-action", result);
    // y emitir event específicos si quieres
    if (payload.action === "eliminated") {
      io.to(`tournament:${payload.tournamentId}`).emit("player-eliminated", { registrationId: payload.payload.registrationId, playerId: payload.payload.playerId });
    }
  });

  socket.on("tournament-control", async ({ tournamentId, type, data }) => {
    // aplica cambios en DB
    // ejemplo: pause
    if (type === "pause") {
      await setTournamentStatus(tournamentId, "Paused");
      io.to(`tournament:${tournamentId}`).emit("tournament-paused", { tournamentId });
    } else if (type === "update-level") {
      await setTournamentLevel(tournamentId, data.level);
      io.to(`tournament:${tournamentId}`).emit("update-level", { level: data.level, timeLeft: data.timeLeft });
    }
  });

  socket.on("send-tournament-data", (tournamentData) => {
    console.log("Enviando tournament-data a todos los displays:", tournamentData);
    io.emit("tournament-data", tournamentData);
  });

  socket.on("disconnect", () => {
    console.log("Cliente desconectado:", socket.id);
    for (const [id, sId] of displays.entries()) {
      if (sId === socket.id) {
        displays.delete(id);
        console.log(`DisplayId ${id} eliminado del mapping`);
        break;
      }
    }
  });
});

// ----------------- HELPERS -----------------
function generateDisplayId() {
  return Math.random().toString(36).substring(2, 10);
}

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});

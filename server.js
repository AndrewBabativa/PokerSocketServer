import express from "express";
import http from "http";
import { Server } from "socket.io";

// ✅ Express básico
const app = express();
const server = http.createServer(app);

app.get("/", (req, res) => {
  res.send("Socket.io server running ✅");
});

// ----------------- HELPERS -----------------
function tournamentRoom(tournamentId) {
  return `tournament:${tournamentId}`;
}

function generateDisplayId() {
  return Math.random().toString(36).substring(2, 10);
}

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
const displays = new Map();

// ----------------- SOCKET EVENTS -----------------
io.on("connection", (socket) => {
  console.log("[Socket.IO] Nuevo cliente conectado:", socket.id);

  // Log de todos los eventos para debug
  socket.onAny((event, payload) => {
    console.log(`[Socket.IO] Evento recibido: ${event}`, payload);
  });

  // Registrar pantalla pública
  socket.on("register-display", () => {
    const displayId = generateDisplayId();
    console.log(`[Socket.IO] Asignando displayId ${displayId} a socket ${socket.id}`);
    displays.set(displayId, socket.id);
    socket.emit("display-id", displayId);
  });

  // Linkear display a torneo (solo join room y emit confirmación)
  socket.on("link-display", ({ displayId, tournamentId }) => {
    console.log(`[Socket.IO] link-display -> displayId=${displayId}, tournamentId=${tournamentId}`);
    const targetSocketId = displays.get(displayId);
    if (!targetSocketId) {
      console.warn(`[Socket.IO] DisplayId ${displayId} no encontrado`);
      return;
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) {
      console.warn(`[Socket.IO] No se encontró targetSocket por id: ${targetSocketId}`);
      return;
    }

    const room = tournamentRoom(tournamentId);
    targetSocket.join(room);
    targetSocket.emit("display-linked", { tournamentId });
    console.log(`[Socket.IO] Display ${displayId} unido a room ${room}`);
  });

  // Join / Leave tournament
  socket.on("join-tournament", ({ tournamentId }) => {
    const room = tournamentRoom(tournamentId);
    socket.join(room);
    console.log(`[Socket.IO] Socket ${socket.id} joined room ${room}`);
  });

  socket.on("leave-tournament", ({ tournamentId }) => {
    const room = tournamentRoom(tournamentId);
    socket.leave(room);
    console.log(`[Socket.IO] Socket ${socket.id} left room ${room}`);
  });

  // Control torneo: pause / resume / update-level
  socket.on("tournament-control", ({ tournamentId, type, data }) => {
    const room = tournamentRoom(tournamentId);
    console.log(`[Socket.IO] tournament-control -> type=${type}, tournamentId=${tournamentId}`);

    // Emitimos evento a todos los clientes conectados a la room
    io.to(room).emit("tournament-control", { type, data });
  });

  // Player actions
  socket.on("player-action", ({ tournamentId, action, payload }) => {
    const room = tournamentRoom(tournamentId);
    io.to(room).emit("player-action", { action, payload });
    console.log(`[Socket.IO] player-action emitido en room ${room}:`, { action, payload });
  });

  // Enviar datos a todos los displays (opcional si frontend necesita actualizar algo manual)
  socket.on("send-tournament-data", (tournamentData) => {
    console.log("[Socket.IO] Enviando tournament-data a todos los displays:", tournamentData);
    io.emit("tournament-data", tournamentData);
  });

  // Desconexión
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

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});

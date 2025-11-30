import express from "express";
import http from "http";
import { Server } from "socket.io";

// ✅ Express básico
const app = express();
const server = http.createServer(app);

// Opcional: endpoint HTTP solo para testing
app.get("/", (req, res) => {
  res.send("Socket.io server running ✅");
});

// ✅ Configuración Socket.io
const io = new Server(server, {
  cors: {
    origin: [
      "https://pokergenys.netlify.app", // tu frontend prod
      "http://localhost:5173"           // tu frontend local
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"] // primero websocket, fallback a polling
});

// ----------------- SOCKET EVENTS -----------------
io.on("connection", (socket) => {
  console.log("Nuevo cliente conectado:", socket.id);

  // Registrar pantalla pública
  socket.on("register-display", () => {
    const displayId = generateDisplayId();
    console.log(`Asignando displayId ${displayId} a socket ${socket.id}`);
    displays.set(displayId, socket.id); // guardamos mapping
    socket.emit("display-id", displayId);
  });

  // Linkear torneo
  socket.on("link-display", ({ displayId, tournamentId }) => {
    console.log(`Link-display -> displayId=${displayId}, tournamentId=${tournamentId}`);
    const targetSocketId = displays.get(displayId);
    if (targetSocketId) {
      io.to(targetSocketId).emit("display-linked", { tournamentId });
      console.log(`Evento display-linked enviado a socket ${targetSocketId}`);
    } else {
      console.warn(`DisplayId ${displayId} no encontrado`);
    }
  });

  // Enviar datos completos del torneo
  socket.on("send-tournament-data", (tournamentData) => {
    console.log("Enviando tournament-data:", tournamentData);
    io.emit("tournament-data", tournamentData);
  });

  socket.on("disconnect", () => {
    console.log("Cliente desconectado:", socket.id);
    // eliminamos el displayId mapeado si existía
    for (const [id, sId] of displays.entries()) {
      if (sId === socket.id) {
        displays.delete(id);
        break;
      }
    }
  });
});

// ----------------- HELPERS -----------------
function generateDisplayId() {
  return Math.random().toString(36).substring(2, 10); // ej: "a1b2c3d4"
}

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server listening on port ${PORT}`);
});

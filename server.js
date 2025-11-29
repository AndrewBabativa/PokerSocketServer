// server.js (Node)
import http from "http";
import express from "express";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// displayId → socketId
const displays = new Map();

io.on("connection", (socket) => {
  console.log("🟢 socket connected:", socket.id);

  // Registro de pantallas públicas
  socket.on("register-display", () => {
    const displayId = uuidv4().split("-")[0];
    displays.set(displayId, socket.id);

    socket.emit("display-id", displayId);
    console.log("📺 registered display:", displayId, "->", socket.id);
  });

  // Admin linkea el display con un torneo
  socket.on("link-display", async ({ displayId, tournamentId }) => {
    console.log("link-display request:", displayId, tournamentId);

    const socketId = displays.get(displayId);

    if (!socketId) {
      socket.emit("link-result", { ok: false, error: "Display not connected" });
      console.log("↩ link failed: display not connected", displayId);
      return;
    }

    // Emitimos el ID para que la pantalla sepa qué torneo debe cargar
    io.to(socketId).emit("display-linked", { tournamentId });
    console.log("-> sent display-linked to", socketId, "for tournament", tournamentId);

   const response = await fetch(`https://pokergenysbackend.onrender.com/tournaments/${tournamentId}`);
  const tournamentData = await response.json();


  console.log('enviando info al tv',tournamentData)
    io.to(socketId).emit("tournament-data", tournamentData);
    console.log("-> sent tournament-data to", socketId, tournamentId);

    // Confirmar al admin que el link fue exitoso
    socket.emit("link-result", { ok: true });
    console.log(`🔗 Link successful → Display ${displayId} → Tournament ${tournamentId}`);
  });

  // Limpieza al desconectar
  socket.on("disconnect", () => {
    for (const [id, sid] of displays.entries()) {
      if (sid === socket.id) {
        displays.delete(id);
        console.log("🗑 removed display mapping:", id);
      }
    }
    console.log("🔴 socket disconnected:", socket.id);
  });
});

server.listen(4000, () => {
  console.log("🔥 Socket server listening on port 4000");
});

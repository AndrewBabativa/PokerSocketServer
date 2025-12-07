import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1. Webhook de Relevo (C# -> Node -> Web)
app.post('/api/webhook/emit', (req, res) => {
    const { tournamentId, event, data } = req.body;

    if (!tournamentId || !event) {
        return res.status(400).json({ error: "Faltan tournamentId o event" });
    }

    const room = `tournament:${tournamentId}`;
    
    // Emitir a la sala específica
    io.to(room).emit(event, data);
    
    console.log(`📢 [Broadcast] ${event} -> Sala: ${tournamentId}`);
    res.status(200).json({ success: true });
});

app.get('/health', (req, res) => res.send("OK"));

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["websocket", "polling"]
});

const displays = new Map(); 

io.on("connection", (socket) => {
    console.log(`🔌 Nuevo cliente: ${socket.id}`);

    // Registro de Pantalla (TV)
    socket.on("register-display", () => {
        const id = Math.random().toString(36).substring(2, 8).toUpperCase();
        displays.set(id, socket.id);
        socket.emit("display-id", id);
        console.log(`📺 TV ID Generado: ${id}`);
    });

    // Vincular Tablet Admin con TV
    socket.on("link-display", ({ displayId, tournamentId }) => {
        const targetSocketId = displays.get(displayId);
        if (targetSocketId) {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                targetSocket.join(`tournament:${tournamentId}`);
                targetSocket.emit("display-linked", { tournamentId });
                console.log(`🔗 Link exitoso: ${displayId} -> Torneo ${tournamentId}`);
            }
        }
    });

    // Unión manual (Admin o Clientes web)
    socket.on("join-tournament", ({ tournamentId }) => {
        if (!tournamentId) return;
        socket.join(`tournament:${tournamentId}`);
        console.log(`👤 Socket ${socket.id} unido a Torneo: ${tournamentId}`);
    });

    socket.on("disconnect", () => {
        // Limpieza eficiente
        for (const [code, id] of displays.entries()) {
            if (id === socket.id) {
                displays.delete(code);
                break;
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Socket Relay listo en puerto ${PORT}`);
});
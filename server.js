import express from "express";
import http from "http";
import { Server } from "socket.io";

// ==========================================
// 1. CONFIGURACIÓN DEL SERVIDOR
// ==========================================
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Logging simplificado
app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.includes('webhook')) {
        // Log solo para ver que C# está hablando
        console.log(`📨 [Webhook] Evento recibido: ${req.body.event}`); 
		 console.log(`📨 [Webhook] res: ${res}`); 
		  console.log(`📨 [Webhook] next: ${next}`); 
    }
    next();
});

app.get('/', (req, res) => res.status(200).send("Poker Socket Relay is Running 🚀"));

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ["websocket", "polling"], 
    pingTimeout: 60000, 
    pingInterval: 25000 
});

// Helper para nombres de salas
const tournamentRoom = (id) => `tournament:${id}`;
const displays = new Map(); // Solo mantenemos esto para vincular TVs

// ==========================================
// 2. WEBHOOK (C# -> Node -> Frontend)
// ==========================================
// Node NO PIENSA, solo RETRANSMITE. C# es el cerebro.
app.post('/api/webhook/emit', (req, res) => {
    const { tournamentId, event, data } = req.body;

    if (!tournamentId || !event) return res.status(400).send("Faltan datos");

    const room = tournamentRoom(tournamentId);
    
    // 🔥 RELEVO DIRECTO 🔥
    // Enviamos exactamente lo que mandó C# a todos en la sala del torneo
    io.to(room).emit(event, data);
    
    console.log(`📢 [Broadcast] ${event} enviado a sala ${tournamentId}`);

    res.status(200).send({ success: true });
});

// ==========================================
// 3. SOCKET EVENTS (Conexiones)
// ==========================================
io.on("connection", (socket) => {
    
    // A. Lógica de Vinculación de TV (Pairing) - SE MANTIENE
    socket.on("register-display", () => {
        const id = Math.random().toString(36).substring(2, 8).toUpperCase();
        displays.set(id, socket.id);
        socket.emit("display-id", id);
        console.log(`📺 Display registrado: ${id}`);
    });

    socket.on("link-display", ({ displayId, tournamentId }) => {
        const targetId = displays.get(displayId);
        if (targetId) {
            const target = io.sockets.sockets.get(targetId);
            if (target) {
                target.join(tournamentRoom(tournamentId));
                target.emit("display-linked", { tournamentId });
                console.log(`🔗 Display ${displayId} vinculado a torneo ${tournamentId}`);
            }
        }
    });

    // B. Unirse a Sala de Torneo
    socket.on("join-tournament", ({ tournamentId }) => {
        if (!tournamentId) return;
        const room = tournamentRoom(tournamentId);
        socket.join(room);
        console.log(`👤 Usuario unido a sala: ${tournamentId}`);
        
        // NOTA: Ya NO intentamos recuperar estado ni calcular tiempo aquí.
        // El Frontend (React) hará un fetch a la API de C# apenas cargue 
        // para obtener el estado inicial exacto.
    });

    socket.on("leave-tournament", ({ tournamentId }) => {
        if(tournamentId) socket.leave(tournamentRoom(tournamentId));
    });
    
    socket.on("disconnect", () => {
        // Limpieza de displays map si se desconecta
        for (const [code, socketId] of displays.entries()) {
            if (socketId === socket.id) {
                displays.delete(code);
                break;
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server Socket (Relay Mode) LISTO en puerto ${PORT}`);
});
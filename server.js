const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// ── Serve static frontend files from /public ──────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Catch-all: send index.html for any unmatched GET (fixes Render deep-link 404s)
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ── Room store ────────────────────────────────────────────────────────────
// rooms[code] = {
//   code, board, currentP, gameOver,
//   players: [ { id, name, symbol } ],   // max 2
//   spectators: [ { id, name } ],
//   scores: { x:0, o:0 },
//   rematchVotes: Set
// }
const rooms = {};

function makeCode() {
    return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A3F9C1"
}

function makeRoom(code) {
    return {
        code,
        board: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        currentP: -1,   // -1=X moves first
        gameOver: false,
        players: [],
        spectators: [],
        scores: { x: 0, o: 0 },
        rematchVotes: new Set()
    };
}

const WIN_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

function analyseBoard(b) {
    for (const [a, c, d] of WIN_LINES) {
        if (b[a] !== 0 && b[a] === b[c] && b[a] === b[d]) return b[a];
    }
    return 0;
}

function roomSummary(room) {
    return {
        code: room.code,
        board: room.board,
        currentP: room.currentP,
        gameOver: room.gameOver,
        players: room.players,
        spectators: room.spectators,
        scores: room.scores
    };
}

// ── Socket events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('connect', socket.id);

    // ── CREATE ROOM ──────────────────────────────────────────────────────
    socket.on('create_room', ({ name }) => {
        let code;
        do { code = makeCode(); } while (rooms[code]);

        const room = makeRoom(code);
        rooms[code] = room;

        room.players.push({ id: socket.id, name: name || 'Player 1', symbol: 'X', value: -1 });
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.name = name;

        socket.emit('room_created', { code, symbol: 'X', room: roomSummary(room) });
        console.log(`Room ${code} created by ${name}`);
    });

    // ── JOIN ROOM ────────────────────────────────────────────────────────
    socket.on('join_room', ({ code, name }) => {
        const room = rooms[code];
        if (!room) { socket.emit('error_msg', 'Room not found.'); return; }

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.name = name;

        if (room.players.length < 2) {
            // Second player
            room.players.push({ id: socket.id, name: name || 'Player 2', symbol: 'O', value: 1 });
            socket.emit('room_joined', { symbol: 'O', room: roomSummary(room) });
            io.to(code).emit('room_update', roomSummary(room));
            io.to(code).emit('system_msg', `${name} joined as O. Game starts!`);
        } else {
            // Spectator
            room.spectators.push({ id: socket.id, name: name || 'Spectator' });
            socket.emit('room_joined', { symbol: 'spectator', room: roomSummary(room) });
            io.to(code).emit('room_update', roomSummary(room));
            io.to(code).emit('system_msg', `${name} is spectating.`);
        }
    });

    // ── MAKE MOVE ────────────────────────────────────────────────────────
    socket.on('make_move', ({ idx }) => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room || room.gameOver) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;                          // spectators can't move
        if (player.value !== room.currentP) return;  // not your turn
        if (room.board[idx] !== 0) return;            // cell taken

        room.board[idx] = room.currentP;

        const result = analyseBoard(room.board);
        if (result !== 0) {
            room.gameOver = true;
            if (result === -1) room.scores.x++;
            else room.scores.o++;
            io.to(code).emit('game_over', { result, board: room.board, scores: room.scores });
        } else if (room.board.every(v => v !== 0)) {
            room.gameOver = true;
            io.to(code).emit('game_over', { result: 0, board: room.board, scores: room.scores });
        } else {
            room.currentP *= -1;
            io.to(code).emit('move_made', { idx, board: room.board, currentP: room.currentP });
        }
    });

    // ── CHAT MESSAGE ─────────────────────────────────────────────────────
    socket.on('chat_msg', ({ text }) => {
        const code = socket.data.roomCode;
        if (!code || !rooms[code]) return;
        const name = socket.data.name || 'Someone';
        if (!text || !text.trim()) return;
        io.to(code).emit('chat_msg', { name, text: text.trim().slice(0, 200) });
    });

    // ── REMATCH ──────────────────────────────────────────────────────────
    socket.on('rematch_vote', () => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room) return;

        room.rematchVotes.add(socket.id);
        const playerIds = room.players.map(p => p.id);

        // Broadcast how many voted
        io.to(code).emit('rematch_status', {
            votes: room.rematchVotes.size,
            needed: room.players.length
        });

        // Both players voted → reset
        if (playerIds.every(id => room.rematchVotes.has(id))) {
            room.board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            room.currentP = -1;
            room.gameOver = false;
            room.rematchVotes = new Set();
            io.to(code).emit('rematch_start', roomSummary(room));
        }
    });

    // ── DISCONNECT ───────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        const room = rooms[code];
        if (!room) return;

        const name = socket.data.name || 'Someone';

        // Remove from players or spectators
        room.players = room.players.filter(p => p.id !== socket.id);
        room.spectators = room.spectators.filter(s => s.id !== socket.id);

        if (room.players.length === 0 && room.spectators.length === 0) {
            delete rooms[code];
            console.log(`Room ${code} deleted`);
        } else {
            io.to(code).emit('room_update', roomSummary(room));
            io.to(code).emit('system_msg', `${name} left the room.`);
        }
    });
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
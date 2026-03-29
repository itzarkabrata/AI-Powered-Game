// ═══════════════════════════════════════════════════════════════
//  SHARED CONSTANTS
// ═══════════════════════════════════════════════════════════════
const WIN_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

// ═══════════════════════════════════════════════════════════════
//  LOCAL GAME STATE
// ═══════════════════════════════════════════════════════════════
let mode         = '';
let board        = [];
let currentP     = -1;    // -1=X, 1=O
let gameOver     = false;
let playerOrder  = 1;     // 1=player first, 2=AI first
let playerSymbol = 'X';   // 'X' or 'O' — what the human chose
let localScores  = { x: 0, o: 0 };

// ═══════════════════════════════════════════════════════════════
//  ONLINE STATE
// ═══════════════════════════════════════════════════════════════
let socket       = null;
let mySymbol     = '';
let myValue      = 0;
let currentRoom  = null;
let isSpectator  = false;
let rematchVoted = false;

// ═══════════════════════════════════════════════════════════════
//  BOOT — wire up every event listener after DOM is ready
// ═══════════════════════════════════════════════════════════════
// Wire up all event listeners (script is at end of body so DOM is already ready)

// ── Mode select ──────────────────────────────────────────────
document.getElementById('btn-mode-local').addEventListener('click', () => selectMode('local2p'));
document.getElementById('btn-mode-ai').addEventListener('click',    () => selectMode('ai'));
document.getElementById('btn-mode-online').addEventListener('click', () => showScreen('screen-online'));

// ── Setup screen ─────────────────────────────────────────────
document.getElementById('btn-start-local').addEventListener('click', startLocalGame);
document.getElementById('btn-back-setup').addEventListener('click',  goHome);
document.getElementById('order-first').addEventListener('click',     () => selectOrder(1));
document.getElementById('order-second').addEventListener('click',    () => selectOrder(2));

// ── Online lobby ─────────────────────────────────────────────
document.getElementById('btn-back-online').addEventListener('click',  goHome);
document.getElementById('btn-create-room').addEventListener('click',  createRoom);
document.getElementById('btn-join-room').addEventListener('click',    joinRoom);
document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

// ── Waiting screen ───────────────────────────────────────────
document.getElementById('btn-leave-room').addEventListener('click',  leaveRoom);
document.getElementById('waiting-code').addEventListener('click',    copyCode);

// ── Game screen ──────────────────────────────────────────────
document.getElementById('btn-new-round').addEventListener('click', resetLocalBoard);
document.getElementById('btn-rematch').addEventListener('click',   voteRematch);
document.getElementById('btn-menu').addEventListener('click',      goHome);

// ── Board cells ──────────────────────────────────────────────
document.querySelectorAll('.cell').forEach((cell) => {
  cell.addEventListener('click', () => {
    const idx = parseInt(cell.getAttribute('data-idx'), 10);
    cellClick(idx);
  });
});

// ── Chat ─────────────────────────────────────────────────────
document.getElementById('btn-chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET INIT
// ═══════════════════════════════════════════════════════════════
function initSocket() {
  if (socket) return;
  socket = io();

  socket.on('connect',    () => setConnStatus(true));
  socket.on('disconnect', () => setConnStatus(false));

  socket.on('room_created', ({ code, symbol, room }) => {
    mySymbol    = symbol;
    myValue     = symbol === 'X' ? -1 : 1;
    isSpectator = false;
    currentRoom = room;
    document.getElementById('waiting-code').childNodes[0].textContent = code;
    showScreen('screen-waiting');
  });

  socket.on('room_joined', ({ symbol, room }) => {
    mySymbol    = symbol;
    myValue     = symbol === 'X' ? -1 : 1;
    isSpectator = symbol === 'spectator';
    currentRoom = room;
    startOnlineGame(room);
  });

  socket.on('room_update', (room) => {
    currentRoom = room;
    updateSpectatorBar(room);
    if (room.players.length === 2 && document.getElementById('screen-waiting').classList.contains('active')) {
      startOnlineGame(room);
    }
  });

  socket.on('move_made', ({ idx, board: b, currentP: cp }) => {
    board    = b;
    currentP = cp;
    renderBoard();
    updateActiveCard();
    setStatus(onlineTurnLabel(cp, currentRoom));
  });

  socket.on('game_over', ({ result, board: b, scores }) => {
    board    = b;
    gameOver = true;
    renderBoard();
    updateActiveCard();
    if (scores) {
      document.getElementById('score-x').textContent = scores.x;
      document.getElementById('score-o').textContent = scores.o;
    }
    if (result !== 0) {
      const winnerName = result === -1
        ? document.getElementById('name-x').textContent
        : document.getElementById('name-o').textContent;
      highlightWin(result);
      setStatus(`${winnerName} wins!`, 'winner');
    } else {
      setStatus("It's a draw!", 'draw');
    }
    if (!isSpectator) showRematchBtn();
  });

  socket.on('rematch_status', ({ votes, needed }) => {
    const banner = document.getElementById('rematch-banner');
    banner.classList.add('visible');
    banner.textContent = `Rematch votes: ${votes}/${needed}`;
  });

  socket.on('rematch_start', (room) => {
    currentRoom  = room;
    rematchVoted = false;
    board        = room.board;
    currentP     = room.currentP;
    gameOver     = false;
    renderBoard();
    updateActiveCard();
    setStatus(onlineTurnLabel(currentP, room));
    document.getElementById('rematch-banner').classList.remove('visible');
    document.getElementById('rematch-banner').textContent = '';
    const btn = document.getElementById('btn-rematch');
    btn.disabled    = false;
    btn.textContent = 'Rematch';
  });

  socket.on('chat_msg',   ({ name, text }) => appendChat(name, text, false));
  socket.on('system_msg', (text)           => appendChat(null, text, true));
  socket.on('error_msg',  (msg)            => {
    document.getElementById('lobby-error').textContent = msg;
  });
}

function setConnStatus(connected) {
  document.getElementById('conn-dot').className   = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
  document.getElementById('conn-label').textContent = connected ? 'connected' : 'offline';
}

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function goHome() {
  if (socket && currentRoom) leaveRoom();
  localScores = { x: 0, o: 0 };
  mode = '';
  showScreen('screen-mode');
}

function selectMode(m) {
  mode = m;
  const isAI = (m === 'ai');
  // Name labels — for local 2p show both; for AI show player name only
  document.getElementById('name1-label').textContent       = isAI ? 'Your Name' : 'Player 1 Name (X)';
  document.getElementById('name2-label').textContent       = 'AI Name';
  document.getElementById('name2-group').style.display     = isAI ? 'flex' : 'flex';
  document.getElementById('name2').value                   = isAI ? 'HAL-9000' : '';
  document.getElementById('name2').readOnly                = isAI;
  document.getElementById('symbol-group').style.display   = isAI ? 'flex' : 'none';
  document.getElementById('order-group').style.display     = isAI ? 'flex' : 'none';
  // Reset symbol to X default
  selectSymbol('X');
  showScreen('screen-setup');
}

function selectSymbol(sym) {
  playerSymbol = sym;
  document.getElementById('symbol-x').classList.toggle('selected', sym === 'X');
  document.getElementById('symbol-o').classList.toggle('selected', sym === 'O');
  // Update order buttons to reflect chosen symbol
  document.getElementById('order-first').textContent  = `You (${sym})`;
  document.getElementById('order-second').textContent = `AI (${sym === 'X' ? 'O' : 'X'})`;
}

function selectOrder(o) {
  playerOrder = o;
  document.getElementById('order-first').classList.toggle('selected',  o === 1);
  document.getElementById('order-second').classList.toggle('selected', o === 2);
}

// ═══════════════════════════════════════════════════════════════
//  LOCAL GAME (2p + AI)
// ═══════════════════════════════════════════════════════════════
function startLocalGame() {
  const n1 = document.getElementById('name1').value.trim() || 'Player 1';
  const n2 = document.getElementById('name2').value.trim() || (mode === 'ai' ? 'HAL-9000' : 'Player 2');

  // In AI mode, assign names based on chosen symbol
  if (mode === 'ai') {
    const aiName = n2;
    const playerName = n1;
    if (playerSymbol === 'X') {
      document.getElementById('name-x').textContent = playerName;
      document.getElementById('name-o').textContent = aiName;
    } else {
      document.getElementById('name-x').textContent = aiName;
      document.getElementById('name-o').textContent = playerName;
    }
  } else {
    document.getElementById('name-x').textContent = n1;
    document.getElementById('name-o').textContent = n2;
  }

  document.getElementById('score-x').textContent = localScores.x;
  document.getElementById('score-o').textContent = localScores.o;

  document.getElementById('btn-new-round').style.display         = 'inline-flex';
  document.getElementById('btn-rematch').style.display           = 'none';
  document.getElementById('chat-panel').style.display            = 'none';
  document.getElementById('spectator-bar').classList.remove('visible');
  document.getElementById('thinking-indicator').style.display    = mode === 'ai' ? 'block' : 'none';

  showScreen('screen-game');
  resetLocalBoard();
}

function resetLocalBoard() {
  board    = [0,0,0,0,0,0,0,0,0];
  gameOver = false;
  currentP = -1; // X always moves first internally
  renderBoard();
  setStatus('');
  updateActiveCard();
  if (mode === 'ai') {
    // playerSymbol: what the human picked ('X' or 'O')
    // playerOrder : 1=human first, 2=AI first
    //
    // Derive whether AI moves first this turn:
    //   human chose X + goes first  → human is X, AI is O → AI does NOT go first
    //   human chose X + AI goes first → AI must play X's turn... but X goes first, contradiction.
    //     In this case AI is still O but human gave up first move → AI plays after human's phantom? No —
    //     "order" means who physically clicks first. If player chose X and said AI first, we swap:
    //     AI becomes X and plays first; player becomes O.
    //   human chose O + player first → player is O, AI is X → AI must play first (X goes first)
    //   human chose O + AI first     → same result, AI (X) goes first
    //
    // Simplified rule:
    //   aiValue = playerSymbol === 'X' ? 1 : -1
    //   aiGoesFirst = (aiValue === -1) OR (playerOrder === 2)
    const aiValue   = (playerSymbol === 'X') ? 1 : -1;  // AI gets opposite of player
    const aiGoesFirst = (aiValue === -1) || (playerOrder === 2);
    if (aiGoesFirst) setTimeout(doAITurn, 400);
  }
}

function cellClick(idx) {
  if (gameOver || board[idx] !== 0) return;

  if (mode === 'online') {
    if (isSpectator) return;
    if (myValue !== currentP) return;
    socket.emit('make_move', { idx });
    return;
  }

  // Block click when it's not the human's turn
  const playerValue = (playerSymbol === 'X') ? -1 : 1;
  if (mode === 'ai' && currentP !== playerValue) return;

  board[idx] = currentP;
  renderCell(idx);
  checkLocalEndTurn();
}

function checkLocalEndTurn() {
  const result = analyseBoard(board);
  if (result !== 0) { endLocalGame(result); return; }
  if (board.every(v => v !== 0)) { endLocalGame(0); return; }
  currentP *= -1;
  updateActiveCard();
  setStatus(localTurnLabel());
  const aiVal = (playerSymbol === 'X') ? 1 : -1;
  if (mode === 'ai' && currentP === aiVal) setTimeout(doAITurn, 350);
}

function endLocalGame(result) {
  gameOver = true;
  updateActiveCard();
  if (result !== 0) {
    highlightWin(result);
    const winner = result === -1
      ? document.getElementById('name-x').textContent
      : document.getElementById('name-o').textContent;
    setStatus(`${winner} wins!`, 'winner');
    if (result === -1) { localScores.x++; document.getElementById('score-x').textContent = localScores.x; }
    else               { localScores.o++; document.getElementById('score-o').textContent = localScores.o; }
  } else {
    setStatus("It's a draw!", 'draw');
  }
}

function localTurnLabel() {
  const nx = document.getElementById('name-x').textContent;
  const no = document.getElementById('name-o').textContent;
  return currentP === -1 ? `${nx}'s turn (X)` : `${no}'s turn (O)`;
}

// ═══════════════════════════════════════════════════════════════
//  AI LOGIC (minimax, ported 1:1 from Python)
// ═══════════════════════════════════════════════════════════════
function analyseBoard(b) {
  for (const [a, c, d] of WIN_LINES) {
    if (b[a] !== 0 && b[a] === b[c] && b[a] === b[d]) return b[a];
  }
  return 0;
}

function minmax(b, player) {
  const x = analyseBoard(b);
  if (x !== 0) return x * player;
  let value = -2, pos = -1;
  for (let i = 0; i < 9; i++) {
    if (b[i] === 0) {
      b[i] = player;
      const score = -minmax(b, player * -1);
      b[i] = 0;
      if (score > value) { value = score; pos = i; }
    }
  }
  return pos === -1 ? 0 : value;
}

function compBestMove(b, aiValue) {
  const playerValue = aiValue * -1;
  let pos = -1, value = -2;
  for (let i = 0; i < 9; i++) {
    if (b[i] === 0) {
      b[i] = aiValue;
      const score = -minmax(b, playerValue);
      b[i] = 0;
      if (score > value) { value = score; pos = i; }
    }
  }
  return pos;
}

function doAITurn() {
  if (gameOver) return;
  // AI always gets the opposite symbol to what the player chose
  const aiValue = (playerSymbol === 'X') ? 1 : -1;
  setThinking(true);
  setTimeout(() => {
    const pos = compBestMove(board, aiValue);
    if (pos !== -1) { board[pos] = aiValue; renderCell(pos); }
    setThinking(false);
    checkLocalEndTurn();
  }, 300);
}

// ═══════════════════════════════════════════════════════════════
//  ONLINE ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function createRoom() {
  initSocket();
  const name = document.getElementById('online-name').value.trim() || 'Player';
  document.getElementById('lobby-error').textContent = '';
  socket.emit('create_room', { name });
}

function joinRoom() {
  initSocket();
  const name = document.getElementById('online-name').value.trim() || 'Player';
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) { document.getElementById('lobby-error').textContent = 'Enter a room code.'; return; }
  document.getElementById('lobby-error').textContent = '';
  socket.emit('join_room', { code, name });
}

function leaveRoom() {
  currentRoom = null;
  if (socket) { socket.disconnect(); socket = null; }
  showScreen('screen-mode');
}

function copyCode() {
  const code = document.getElementById('waiting-code').childNodes[0].textContent.trim();
  navigator.clipboard.writeText(code).then(() => {
    const hint = document.querySelector('#waiting-code .copy-hint');
    hint.textContent = 'copied!';
    setTimeout(() => { hint.textContent = 'click to copy'; }, 1500);
  });
}

// ═══════════════════════════════════════════════════════════════
//  ONLINE GAME START
// ═══════════════════════════════════════════════════════════════
function startOnlineGame(room) {
  mode        = 'online';
  board       = room.board;
  currentP    = room.currentP;
  gameOver    = room.gameOver;
  currentRoom = room;

  const px = room.players.find(p => p.symbol === 'X');
  const po = room.players.find(p => p.symbol === 'O');
  document.getElementById('name-x').textContent  = px ? px.name : 'Player 1';
  document.getElementById('name-o').textContent  = po ? po.name : 'Player 2';
  document.getElementById('score-x').textContent = room.scores.x;
  document.getElementById('score-o').textContent = room.scores.o;

  document.getElementById('btn-new-round').style.display           = 'none';
  document.getElementById('btn-rematch').style.display             = isSpectator ? 'none' : 'inline-flex';
  document.getElementById('btn-rematch').disabled                  = false;
  document.getElementById('btn-rematch').textContent               = 'Rematch';
  document.getElementById('chat-panel').style.display              = 'flex';
  document.getElementById('thinking-indicator').style.display      = 'none';
  document.getElementById('spectator-bar').classList.toggle('visible', isSpectator);

  renderBoard();
  updateActiveCard();
  setStatus(onlineTurnLabel(currentP, room));
  showScreen('screen-game');
  updateSpectatorBar(room);
}

function onlineTurnLabel(cp, room) {
  if (!room || room.players.length < 2) return 'Waiting...';
  const px = room.players.find(p => p.symbol === 'X');
  const po = room.players.find(p => p.symbol === 'O');
  return cp === -1
    ? `${px ? px.name : 'X'}'s turn (X)`
    : `${po ? po.name : 'O'}'s turn (O)`;
}

function updateSpectatorBar(room) {
  const bar = document.getElementById('spectator-bar');
  if (isSpectator) {
    bar.classList.add('visible');
    bar.textContent = `👁 Spectating · ${room.spectators.length} spectator(s)`;
  } else if (room.spectators.length > 0) {
    bar.classList.add('visible');
    bar.textContent = `👁 ${room.spectators.length} spectator(s) watching`;
  } else {
    bar.classList.remove('visible');
  }
}

// ═══════════════════════════════════════════════════════════════
//  REMATCH
// ═══════════════════════════════════════════════════════════════
function showRematchBtn() {
  const btn = document.getElementById('btn-rematch');
  btn.style.display = 'inline-flex';
  btn.disabled      = false;
}

function voteRematch() {
  if (!socket || rematchVoted) return;
  rematchVoted = true;
  socket.emit('rematch_vote');
  const btn = document.getElementById('btn-rematch');
  btn.disabled    = true;
  btn.textContent = 'Voted!';
}

// ═══════════════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════════════
function sendChat() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat_msg', { text });
  input.value = '';
}

function appendChat(name, text, isSystem) {
  const box = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = 'chat-msg' + (isSystem ? ' system' : '');
  if (!isSystem && name) {
    const nameEl = document.createElement('span');
    nameEl.className   = 'chat-name';
    nameEl.textContent = name;
    msg.appendChild(nameEl);
  }
  msg.appendChild(document.createTextNode(text));
  box.appendChild(msg);
  box.scrollTop = box.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
//  RENDER HELPERS
// ═══════════════════════════════════════════════════════════════
function renderBoard() {
  document.querySelectorAll('.cell').forEach((cell, i) => {
    cell.innerHTML = '';
    cell.classList.remove('taken', 'win-cell', 'locked');
    if (board[i] === -1) { cell.innerHTML = '<span class="mark x">X</span>'; cell.classList.add('taken'); }
    else if (board[i] === 1) { cell.innerHTML = '<span class="mark o">O</span>'; cell.classList.add('taken'); }
  });
}

function renderCell(idx) {
  const cell = document.querySelector(`.cell[data-idx="${idx}"]`);
  cell.classList.add('taken');
  if (board[idx] === -1) cell.innerHTML = '<span class="mark x">X</span>';
  if (board[idx] ===  1) cell.innerHTML = '<span class="mark o">O</span>';
}

function setStatus(msg, type = '') {
  const bar     = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className   = 'status-bar ' + type;
}

function updateActiveCard() {
  document.getElementById('card-x').classList.toggle('active-player', currentP === -1 && !gameOver);
  document.getElementById('card-o').classList.toggle('active-player', currentP ===  1 && !gameOver);
}

function setThinking(v) {
  document.getElementById('thinking-indicator').classList.toggle('visible', v);
}

function highlightWin(player) {
  for (const line of WIN_LINES) {
    if (line.every(i => board[i] === player)) {
      line.forEach(i => document.querySelector(`.cell[data-idx="${i}"]`).classList.add('win-cell'));
      return;
    }
  }
}

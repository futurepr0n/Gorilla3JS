// simplified-server.js
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 6060;
const GAME_FILE = path.join(__dirname, 'gorilla-game.html');

// Create HTTP server
const server = http.createServer((req, res) => {
  console.log(`HTTP request: ${req.method} ${req.url}`);
  
  // Set CORS headers to allow connections from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle OPTIONS requests for CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }

  fs.readFile(GAME_FILE, (error, content) => {
    if (error) {
      console.error('Error reading game file:', error);
      res.writeHead(500);
      res.end('Error loading game');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ 
  server,
  maxPayload: 4096,
  // This explicitly sets the protocol to handle upgrade properly
  handleProtocols: (protocols) => {
    return protocols[0];
  }
});

console.log(`Server starting on port ${PORT}...`);
console.log(`Open http://localhost:${PORT} or http://YOUR_IP_ADDRESS:${PORT}`);

// Store active games and clients
const games = new Map();
const clients = new Map();

// Connection handler
wss.on('connection', (ws, req) => {
    console.log(`New WebSocket connection from ${req.socket.remoteAddress}`);
    
    // Generate a unique client ID
    const clientId = Math.random().toString(36).substring(2, 15);
    clients.set(ws, { id: clientId });
    
    // Send an initial confirmation message
    ws.send(JSON.stringify({
        type: 'connection_established',
        clientId: clientId
    }));
    
    // Message handler
    ws.on('message', (message) => {
        try {
            // Ensure proper parsing of the message
            const messageStr = message.toString();
            const parsed = JSON.parse(messageStr);
            if (parsed && games.has(parsed.gameId)) games.get(parsed.gameId).lastActive = Date.now();
            
            const data = parsed;
            
            switch (data.type) {
                case 'game_register':
                    handleGameRegister(ws, data);
                    break;
                    
                case 'controller_connect':
                    handleControllerConnect(ws, data);
                    break;
                    
                case 'throw':
                    handleThrow(ws, data);
                    break;

                case 'aim':
                    handleAim(ws, data);
                    break;
                    
                case 'game_state_update':
                    handleGameStateUpdate(ws, data);
                    break;
                    
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing message:', error);
            // Send error back to client
            sendError(ws, 'Error processing message: ' + error.message);
        }
    });
    
    // Handle disconnections
    ws.on('close', () => {
        handleDisconnect(ws);
    });
    
    // Handle errors
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Handle WebSocket server errors
wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
});

// Handle game registration
function handleGameRegister(ws, data) {
    const { gameId } = data;
    
    console.log(`Registering game with ID: ${gameId}`);
    
    // Create or update game entry
    if (!games.has(gameId)) {
        games.set(gameId, {
            gameScreen: ws,
            players: [],
            lastActive: Date.now(),
            state: {
                gameStarted: false,
                currentTurn: 0,
                scores: [0, 0],
                wind: 0
            }
        });
    } else {
        // Update existing game with new connection
        const game = games.get(gameId);
        game.gameScreen = ws;
    }
    
    // Update client info
    clients.get(ws).gameId = gameId;
    clients.get(ws).role = 'game';
    
    // Confirm registration to the game screen
    ws.send(JSON.stringify({
        type: 'game_registered',
        gameId: gameId
    }));
}

// Handle controller connection
function handleControllerConnect(ws, data) {
    const { gameId, playerId } = data;
    
    console.log(`Controller ${playerId} trying to connect to game ${gameId}`);
    
    // Check if game exists
    if (!games.has(gameId)) {
        console.log(`Game ${gameId} not found for controller ${playerId}`);
        sendError(ws, 'Game not found');
        return;
    }
    
    const game = games.get(gameId);
    
    // Check if player is reconnecting
    const existingPlayerIndex = game.players.findIndex(p => p.playerId === playerId);
    
    if (existingPlayerIndex >= 0) {
        // Player is reconnecting
        game.players[existingPlayerIndex].ws = ws;
        const playerIndex = game.players[existingPlayerIndex].index;
        
        // Update client info
        clients.get(ws).gameId = gameId;
        clients.get(ws).playerId = playerId;
        clients.get(ws).role = 'controller';
        
        // Notify controller of successful connection
        ws.send(JSON.stringify({
            type: 'controller_connected',
            playerIndex: playerIndex
        }));
        ws.send(JSON.stringify({
            type: 'game_state',
            state: {
                gameStarted: game.state.gameStarted,
                isYourTurn: playerIndex === game.state.currentTurn,
                scores: game.state.scores,
                wind: game.state.wind,
                hit: null
            }
        }));
        
        if (game.gameScreen && game.gameScreen.readyState === WebSocket.OPEN) {
            game.gameScreen.send(JSON.stringify({
                type: 'player_connected',
                playerIndex: playerIndex,
                playerId: playerId
            }));
        }
        
        console.log(`Player ${playerId} reconnected to game ${gameId} as player ${playerIndex + 1}`);
    } else if (game.players.length < 2) {
        // New player is joining
        const playerIndex = game.players.length;
        
        // Add player to game
        game.players.push({
            ws: ws,
            playerId: playerId,
            index: playerIndex
        });
        
        // Update client info
        clients.get(ws).gameId = gameId;
        clients.get(ws).playerId = playerId;
        clients.get(ws).role = 'controller';
        
        // Notify controller of successful connection
        ws.send(JSON.stringify({
            type: 'controller_connected',
            playerIndex: playerIndex
        }));
        
        // Notify game screen of new player
        if (game.gameScreen && game.gameScreen.readyState === WebSocket.OPEN) {
            game.gameScreen.send(JSON.stringify({
                type: 'player_connected',
                playerIndex: playerIndex,
                playerId: playerId
            }));
        }
        
        console.log(`Player ${playerId} joined game ${gameId} as player ${playerIndex + 1}`);
    } else {
        // Game is full
        console.log(`Game ${gameId} is full, rejecting controller ${playerId}`);
        sendError(ws, 'Game is full');
    }
}

// Handle throw action
function handleAim(ws, data) {
    const game = games.get(data.gameId);
    if (!game) return;
    const playerIndex = game.players.findIndex(p => p.playerId === data.playerId);
    const angle = Number(data.angle);
    if (playerIndex === -1 || game.state.currentTurn !== playerIndex || !Number.isFinite(angle)) return;
    if (game.gameScreen && game.gameScreen.readyState === WebSocket.OPEN) {
        game.gameScreen.send(JSON.stringify({
            type: 'aim_update',
            playerIndex: playerIndex,
            angle: Math.min(90, Math.max(0, angle))
        }));
    }
}

function handleThrow(ws, data) {
    const { gameId, playerId, velocity } = data;
    const angle = Number(data.angle);
    const power = Number(data.power);
    
    // Check if game exists
    if (!games.has(gameId)) {
        sendError(ws, 'Game not found');
        return;
    }
    
    const game = games.get(gameId);
    
    // Find player
    const playerIndex = game.players.findIndex(p => p.playerId === playerId);
    
    if (playerIndex === -1) {
        sendError(ws, 'Player not found in game');
        return;
    }
    
    // Validate that it's this player's turn
    if (game.state.currentTurn !== playerIndex) {
        sendError(ws, 'Not your turn');
        return;
    }
    if (!Number.isFinite(angle) || !Number.isFinite(power)) {
        sendError(ws, 'Invalid throw');
        return;
    }
    
    // Forward throw to game screen
    if (game.gameScreen && game.gameScreen.readyState === WebSocket.OPEN) {
        game.gameScreen.send(JSON.stringify({
            type: 'throw_action',
            playerIndex: playerIndex,
            angle: Math.min(90, Math.max(0, angle)),
            power: Math.min(100, Math.max(1, power)),
            velocity: velocity
        }));
        
        console.log(`Player ${playerIndex + 1} threw a banana with power ${power}, angle ${angle}`);
    }
}

// Handle game state update
function handleGameStateUpdate(ws, data) {
    const { gameId, state } = data;
    
    // Check if game exists
    if (!games.has(gameId)) {
        sendError(ws, 'Game not found');
        return;
    }
    
    const game = games.get(gameId);
    if (game.gameScreen !== ws || !state || typeof state !== 'object') return;
    
    // Update game state
    game.state = state;
    const hit = state.hit && Number.isInteger(state.hit.id)
        ? { id: state.hit.id, scorer: Number(state.hit.scorer), victim: Number(state.hit.victim) }
        : null;
    
    // Broadcast to all controllers
    for (const player of game.players) {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'game_state',
                state: {
                    gameStarted: state.gameStarted,
                    isYourTurn: player.index === state.currentTurn,
                    scores: state.scores,
                    wind: state.wind,
                    hit: hit
                }
            }));
        }
    }
    
    console.log(`Game ${gameId} state updated: Turn=${state.currentTurn}, Scores=${state.scores}`);
}

// Handle client disconnect
function handleDisconnect(ws) {
    const clientInfo = clients.get(ws);
    
    if (!clientInfo) return;
    
    console.log(`Client disconnected: ${clientInfo.id}`);
    
    if (clientInfo.role === 'controller' && clientInfo.gameId) {
        const game = games.get(clientInfo.gameId);
        
        if (game) {
            // Mark player as disconnected but keep their slot
            const playerIndex = game.players.findIndex(p => p.playerId === clientInfo.playerId);
            
            if (playerIndex >= 0) {
                console.log(`Player ${playerIndex + 1} disconnected from game ${clientInfo.gameId}`);
                
                // Notify game screen
                if (game.gameScreen && game.gameScreen.readyState === WebSocket.OPEN) {
                    game.gameScreen.send(JSON.stringify({
                        type: 'player_disconnected',
                        playerIndex: playerIndex
                    }));
                }
            }
        }
    } else if (clientInfo.role === 'game' && clientInfo.gameId) {
        // Game screen disconnected
        console.log(`Game screen for game ${clientInfo.gameId} disconnected`);
    }
    
    clients.delete(ws);
}

// Send error message to client
function sendError(ws, message) {
    try {
        ws.send(JSON.stringify({
            type: 'error',
            message: message
        }));
    } catch (error) {
        console.error('Error sending error message:', error);
    }
}

// Start the server
const IDLE_GAME_MS = 10 * 60 * 1000;
const isOpen = (sock) => sock && sock.readyState === WebSocket.OPEN;

setInterval(() => {
    const now = Date.now();
    for (const [gameId, game] of games) {
        const connected = isOpen(game.gameScreen) || game.players.some(p => isOpen(p.ws));
        if (!connected && now - game.lastActive > IDLE_GAME_MS) {
            games.delete(gameId);
            console.log(`Removed idle game ${gameId}`);
        }
    }
}, 60 * 1000).unref();

server.listen(PORT, () => {
    console.log(`Server is now running on port ${PORT}`);
});
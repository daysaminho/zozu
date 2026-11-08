import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { DEBATE_TOPICS, ZOZU_MISSIONS } from './cards.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3333;

// In-memory room store: Map<roomCode, roomObject>
const rooms = new Map();

// Multi-tier Rate Limiting:
// 1. IP rate limit: >= 1500 req/min (handles 12+ players on the same Wi-Fi box)
// 2. Room creation limit: 15 rooms/min per IP
// 3. Player token rate limit: 120 req/min per player token
const ipRateMap = new Map();
const ipCreateRoomMap = new Map();
const tokenRateMap = new Map();

function checkIpRateLimit(ip) {
  const now = Date.now();
  let record = ipRateMap.get(ip);
  if (!record || now - record.resetTime > 60000) {
    record = { count: 1, resetTime: now };
    ipRateMap.set(ip, record);
    return true;
  }
  record.count++;
  return record.count <= 2000; // Large margin above 1500 req/min
}

function checkCreateRoomRateLimit(ip) {
  const now = Date.now();
  let record = ipCreateRoomMap.get(ip);
  if (!record || now - record.resetTime > 60000) {
    record = { count: 1, resetTime: now };
    ipCreateRoomMap.set(ip, record);
    return true;
  }
  record.count++;
  return record.count <= 15; // Max 15 room creations per min
}

function checkTokenRateLimit(token) {
  if (!token) return true;
  const now = Date.now();
  let record = tokenRateMap.get(token);
  if (!record || now - record.resetTime > 60000) {
    record = { count: 1, resetTime: now };
    tokenRateMap.set(token, record);
    return true;
  }
  record.count++;
  return record.count <= 120; // 120 req/min per player
}

// Clean up inactive rooms older than 2 hours every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - (room.lastActiveAt || room.created) > 2 * 60 * 60 * 1000) {
      console.log(`[CLEANUP] Room ${code} purged due to inactivity.`);
      rooms.delete(code);
    }
  }
  for (const [ip, rec] of ipRateMap.entries()) {
    if (now - rec.resetTime > 120000) ipRateMap.delete(ip);
  }
  for (const [ip, rec] of ipCreateRoomMap.entries()) {
    if (now - rec.resetTime > 120000) ipCreateRoomMap.delete(ip);
  }
  for (const [tok, rec] of tokenRateMap.entries()) {
    if (now - rec.resetTime > 120000) tokenRateMap.delete(tok);
  }
}, 15 * 60 * 1000);

// Decks filtrés pour le jeu en ligne (le client ne peut jamais forcer un deck)
const ONLINE_TOPICS = DEBATE_TOPICS.filter(t => t.deck === 'both' || t.deck === 'online');
const ONLINE_MISSIONS = ZOZU_MISSIONS.filter(m => m.deck === 'both' || m.deck === 'online');

// Gestion de la mémoire des tirages sans répétition pour les salons en ligne
function pickTopicForRoom(room) {
  if (!room.usedTopics) room.usedTopics = [];
  let available = ONLINE_TOPICS.filter(t => !room.usedTopics.includes(t.title));
  if (available.length === 0) {
    const lastTopicTitle = room.topic ? room.topic.title : null;
    room.usedTopics = lastTopicTitle ? [lastTopicTitle] : [];
    available = ONLINE_TOPICS.filter(t => !room.usedTopics.includes(t.title));
    if (available.length === 0) available = ONLINE_TOPICS;
  }
  const picked = available[Math.floor(Math.random() * available.length)];
  room.usedTopics.push(picked.title);
  return picked;
}

function assignMissionsForRoom(room, zozuPlayers) {
  room.missions = {};
  if (!room.usedMissions) room.usedMissions = [];
  if (!room.previousMissions) room.previousMissions = {};

  const currentRoundTexts = new Set();
  for (const p of zozuPlayers) {
    const prevText = room.previousMissions[p.id] || null;
    let pool = ONLINE_MISSIONS.filter(m =>
      !room.usedMissions.includes(m.text) &&
      !currentRoundTexts.has(m.text) &&
      m.text !== prevText
    );

    if (pool.length === 0) {
      room.usedMissions = [...currentRoundTexts];
      pool = ONLINE_MISSIONS.filter(m =>
        !currentRoundTexts.has(m.text) &&
        m.text !== prevText
      );
      if (pool.length === 0) {
        pool = ONLINE_MISSIONS.filter(m => !currentRoundTexts.has(m.text));
      }
      if (pool.length === 0) pool = ONLINE_MISSIONS;
    }

    const picked = pool[Math.floor(Math.random() * pool.length)];
    room.missions[p.id] = picked;
    currentRoundTexts.add(picked.text);
    room.usedMissions.push(picked.text);
  }

  // Mémoriser pour la manche suivante (aucun Zozu ne reçoit la même mission 2 manches de suite)
  room.previousMissions = {};
  for (const p of zozuPlayers) {
    room.previousMissions[p.id] = room.missions[p.id] ? room.missions[p.id].text : null;
  }
}

// 32 characters avoiding ambiguous ones (no 0/O, 1/I)
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARS.charAt(Math.floor(Math.random() * ROOM_CODE_CHARS.length));
  }
  return code;
}

function sanitizeName(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/[<>'"&]/g, '')
    .substring(0, 20);
}

function verifyPlayer(room, playerId, token) {
  if (!room || !playerId || !token) return false;
  return room.tokens[playerId] === token;
}

function isHost(room, playerId, token) {
  if (!verifyPlayer(room, playerId, token)) return false;
  return room.hostId === playerId;
}

function transferHostIfNeeded(room) {
  if (!room.players.length) return;
  const currentHostStillThere = room.players.some(p => p.id === room.hostId);
  if (!currentHostStillThere) {
    const nextHost = room.players[0];
    room.hostId = nextHost.id;
    room.players.forEach(p => { p.isHost = (p.id === nextHost.id); });
    console.log(`[ROOM ${room.code}] Host migrated to ${nextHost.name} (${nextHost.id})`);
  }
}

function tallyVotes(room) {
  const alivePlayers = room.players.filter(p => !room.eliminatedIds.includes(p.id));
  const voteCounts = {};
  alivePlayers.forEach(p => { voteCounts[p.id] = 0; });

  for (const [voterId, targetId] of Object.entries(room.votes)) {
    if (voteCounts[targetId] !== undefined) {
      voteCounts[targetId]++;
    }
  }

  // Find max votes
  let maxV = -1;
  let candidates = [];
  for (const [pId, cnt] of Object.entries(voteCounts)) {
    if (cnt > maxV) {
      maxV = cnt;
      candidates = [pId];
    } else if (cnt === maxV) {
      candidates.push(pId);
    }
  }

  // Tie-breaker: random among tied candidates
  let eliminatedId = null;
  if (candidates.length > 0) {
    eliminatedId = candidates[Math.floor(Math.random() * candidates.length)];
  } else if (alivePlayers.length > 0) {
    eliminatedId = alivePlayers[0].id;
  }

  if (eliminatedId) {
    room.eliminatedIds.push(eliminatedId);
  }

  const eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
  const wasZozu = room.zozuIds.includes(eliminatedId);

  const aliveZozus = room.zozuIds.filter(id => !room.eliminatedIds.includes(id));
  const aliveInnocents = room.players.filter(p => !room.zozuIds.includes(p.id) && !room.eliminatedIds.includes(p.id));

  let outcome = 'continue'; // 'debateurs_win', 'zozus_win', 'continue'
  if (aliveZozus.length === 0) {
    outcome = 'debateurs_win';
    room.status = 'ended';
  } else if (aliveZozus.length >= aliveInnocents.length) {
    outcome = 'zozus_win';
    room.status = 'ended';
  } else {
    outcome = 'continue';
    room.status = 'result';
  }

  room.lastResult = {
    eliminatedId,
    eliminatedName: eliminatedPlayer ? eliminatedPlayer.name : 'Inconnu',
    eliminatedColorIndex: eliminatedPlayer ? eliminatedPlayer.colorIndex : 1,
    wasZozu,
    mission: wasZozu ? (room.missions[eliminatedId] || null) : null,
    aliveZozusCount: aliveZozus.length,
    aliveInnocentsCount: aliveInnocents.length,
    outcome,
    voteCounts
  };

  console.log(`[ROOM ${room.code}] Tally done: eliminated ${room.lastResult.eliminatedName} (Zozu: ${wasZozu}), outcome: ${outcome}`);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Rate Limiting on /api/ endpoints only (static files are unrestricted)
  if (pathname.startsWith('/api/')) {
    if (!checkIpRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Trop de requêtes depuis cette connexion (IP). Merci de ralentir un instant !' }));
      return;
    }

    if (pathname === '/api/create-room' && !checkCreateRoomRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Trop de salons créés récemment. Merci de patienter un instant !' }));
      return;
    }
  }

  // Helper to read JSON body and check token rate limit
  function readJson(callback) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e5) { // 100kb limit
        req.socket.destroy();
      }
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.token && !checkTokenRateLimit(data.token)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Trop de requêtes pour ce joueur. Merci de patienter un instant !' }));
          return;
        }
        callback(null, data);
      } catch (err) {
        callback(err, {});
      }
    });
  }

  // =========================================================================
  // --- ROUTES MULTIJOUEUR SALON EN LIGNE ---
  // =========================================================================

  // 0. OBTENIR LES CARTES LOCALES (Pass & Play / Banque unique)
  if (pathname === '/api/cards' && req.method === 'GET') {
    const localTopics = DEBATE_TOPICS.filter(t => t.deck === 'both' || t.deck === 'local');
    const localMissions = ZOZU_MISSIONS.filter(m => m.deck === 'both' || m.deck === 'local');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(JSON.stringify({
      topics: localTopics,
      missions: localMissions
    }));
    return;
  }

  // 1. CRÉER UN SALON
  if (pathname === '/api/create-room' && req.method === 'POST') {
    readJson((err, data) => {
      const hostName = sanitizeName(data.hostName) || 'Hôte';
      let code;
      let attempts = 0;
      do {
        code = generateRoomCode();
        attempts++;
      } while (rooms.has(code) && attempts < 100);

      const hostId = 'p_' + crypto.randomUUID().substring(0, 8);
      const hostToken = crypto.randomUUID();

      const room = {
        code,
        hostId,
        tokens: { [hostId]: hostToken },
        players: [{ id: hostId, name: hostName, isHost: true, colorIndex: 1 }],
        status: 'lobby', // lobby, revealing, debating, voting, result, ended
        round: 1,
        topic: null,
        zozuCount: 1,
        zozuIds: [],
        missions: {},
        revealedPlayerIds: [],
        revealDeadline: 0,
        debateEndsAt: 0,
        voteEndsAt: 0,
        votes: {},
        eliminatedIds: [],
        lastResult: null,
        usedTopics: [],
        usedMissions: [],
        previousMissions: {},
        created: Date.now(),
        lastActiveAt: Date.now()
      };

      rooms.set(code, room);
      console.log(`[ROOM CREATED] Code: ${code} by ${hostName} (${hostId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        roomCode: code,
        playerId: hostId,
        token: hostToken,
        isHost: true
      }));
    });
    return;
  }

  // 2. REJOINDRE UN SALON
  if (pathname === '/api/join-room' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const playerName = sanitizeName(data.playerName);

      if (!playerName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Merci de renseigner un prénom valide (max 20 caractères).' }));
        return;
      }

      const room = rooms.get(code);
      if (!room) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Oups ! Salon introuvable. Vérifie le code à 4 lettres !' }));
        return;
      }

      room.lastActiveAt = Date.now();

      // Check if player is reconnecting with an existing session token
      if (data.playerId && data.token && verifyPlayer(room, data.playerId, data.token)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          roomCode: code,
          playerId: data.playerId,
          token: data.token,
          isHost: room.hostId === data.playerId
        }));
        return;
      }

      if (room.status !== 'lobby') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'La partie est déjà en cours dans ce salon !' }));
        return;
      }

      if (room.players.length >= 12) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Ce salon est complet (12 joueurs max).' }));
        return;
      }

      // Check duplicate name
      const nameTaken = room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase());
      if (nameTaken) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Oups ! Quelqu'un s'appelle déjà "${playerName}" dans ce salon. Choisis un autre prénom ou petit surnom !`
        }));
        return;
      }

      const playerId = 'p_' + crypto.randomUUID().substring(0, 8);
      const playerToken = crypto.randomUUID();
      room.tokens[playerId] = playerToken;

      const playerColorIndex = room.players.length + 1;
      room.players.push({
        id: playerId,
        name: playerName,
        isHost: false,
        colorIndex: playerColorIndex
      });

      console.log(`[ROOM ${code}] Player joined: ${playerName} (${playerId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        roomCode: code,
        playerId,
        token: playerToken,
        isHost: false
      }));
    });
    return;
  }

  // 3. QUITTER LE SALON (AVEC MIGRATION AUTOMATIQUE DE L'HÔTE)
  if (pathname === '/api/leave-room' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token } = data;
      const room = rooms.get(code);

      if (!room || !verifyPlayer(room, playerId, token)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      room.lastActiveAt = Date.now();
      delete room.tokens[playerId];
      room.players = room.players.filter(p => p.id !== playerId);

      // If room is empty, delete
      if (room.players.length === 0) {
        rooms.delete(code);
        console.log(`[ROOM ${code}] All players left, room destroyed.`);
      } else {
        transferHostIfNeeded(room);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // 4. CHANGER LE NOMBRE DE ZOZU (HÔTE UNIQUEMENT)
  if (pathname === '/api/update-zozu-count' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token, zozuCount } = data;
      const room = rooms.get(code);

      if (!room || !isHost(room, playerId, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Action réservée à l\'hôte du salon.' }));
        return;
      }

      const maxZ = Math.max(1, Math.floor((room.players.length - 1) / 2));
      room.zozuCount = Math.max(1, Math.min(parseInt(zozuCount, 10) || 1, maxZ));
      room.lastActiveAt = Date.now();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, zozuCount: room.zozuCount }));
    });
    return;
  }

  // 5. LANCER LA PARTIE (HÔTE UNIQUEMENT)
  if (pathname === '/api/start-room' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token, zozuCount } = data;
      const room = rooms.get(code);

      if (!room) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Salon introuvable.' }));
        return;
      }

      if (!isHost(room, playerId, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Seul l\'hôte peut lancer la partie !' }));
        return;
      }

      if (room.players.length < 3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Il faut au moins 3 joueurs pour démarrer !' }));
        return;
      }

      room.lastActiveAt = Date.now();

      // Figer définitivement les couleurs selon l'ordre au lancement
      room.players.forEach((p, idx) => {
        p.colorIndex = idx + 1;
      });

      // Calcul du nombre de Zozus
      const maxZ = Math.max(1, Math.floor((room.players.length - 1) / 2));
      const targetZozuCount = Math.max(1, Math.min(parseInt(zozuCount, 10) || room.zozuCount || 1, maxZ));
      room.zozuCount = targetZozuCount;

      // Tirage aléatoire sans remise des Zozus
      const shuffledPlayerIndices = room.players.map((_, i) => i);
      for (let i = shuffledPlayerIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledPlayerIndices[i], shuffledPlayerIndices[j]] = [shuffledPlayerIndices[j], shuffledPlayerIndices[i]];
      }
      const pickedZozuPlayers = shuffledPlayerIndices.slice(0, targetZozuCount).map(idx => room.players[idx]);
      room.zozuIds = pickedZozuPlayers.map(p => p.id);

      // Réinitialisation de la mémoire pour une nouvelle partie
      room.usedTopics = [];
      room.usedMissions = [];
      room.previousMissions = {};

      // Attribution de missions distinctes à chaque Zozu sans répétition
      assignMissionsForRoom(room, pickedZozuPlayers);

      // Sujet de débat sans répétition
      room.topic = pickTopicForRoom(room);

      // Passage à l'état "revealing" (carte secrète individuelle)
      room.status = 'revealing';
      room.round = 1;
      room.revealedPlayerIds = [];
      room.revealDeadline = Date.now() + 60000; // 60 secondes max pour lire son rôle
      room.votes = {};
      room.eliminatedIds = [];
      room.lastResult = null;

      console.log(`[ROOM ${code}] Game started! Zozus: ${room.zozuIds.length}, Status: revealing`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, zozuCount: room.zozuCount }));
    });
    return;
  }

  // 6. CONFIRMER LA LECTURE DU RÔLE ("J'AI COMPRIS")
  if (pathname === '/api/confirm-reveal' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token } = data;
      const room = rooms.get(code);

      if (!room || !verifyPlayer(room, playerId, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Non autorisé.' }));
        return;
      }

      room.lastActiveAt = Date.now();

      if (room.status === 'revealing') {
        if (!room.revealedPlayerIds.includes(playerId)) {
          room.revealedPlayerIds.push(playerId);
        }

        // Si tous les joueurs ont validé -> passage direct au débat !
        const activePlayers = room.players.filter(p => !room.eliminatedIds.includes(p.id));
        if (room.revealedPlayerIds.length >= activePlayers.length) {
          room.status = 'debating';
          room.debateEndsAt = Date.now() + 120000; // 2 minutes
          console.log(`[ROOM ${code}] All confirmed cards -> Debating started!`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // 7. PASSER AU VOTE IMMÉDIATEMENT (HÔTE UNIQUEMENT)
  if (pathname === '/api/skip-to-vote' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token } = data;
      const room = rooms.get(code);

      if (!room || !isHost(room, playerId, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Seul l\'hôte peut abréger le débat.' }));
        return;
      }

      room.lastActiveAt = Date.now();

      if (room.status === 'debating' || room.status === 'revealing') {
        room.status = 'voting';
        room.votes = {};
        room.voteEndsAt = Date.now() + 45000; // 45s de vote
        console.log(`[ROOM ${code}] Host skipped to vote!`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // 8. VOTER POUR UN SUSPECT
  if (pathname === '/api/cast-vote' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token, targetPlayerId } = data;
      const room = rooms.get(code);

      if (!room || !verifyPlayer(room, playerId, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Non autorisé.' }));
        return;
      }

      room.lastActiveAt = Date.now();

      if (room.status !== 'voting') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Le vote n\'est pas actif actuellement.' }));
        return;
      }

      // Eliminated players cannot vote
      if (room.eliminatedIds.includes(playerId)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Tu es éliminé et ne peux pas voter.' }));
        return;
      }

      // Target must be alive and valid
      const targetAlive = room.players.some(p => p.id === targetPlayerId && !room.eliminatedIds.includes(p.id));
      if (!targetAlive) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Cible de vote invalide.' }));
        return;
      }

      room.votes[playerId] = targetPlayerId;

      // Check if all alive players have voted -> tally immediately
      const alivePlayers = room.players.filter(p => !room.eliminatedIds.includes(p.id));
      const votesReceived = Object.keys(room.votes).length;
      if (votesReceived >= alivePlayers.length) {
        tallyVotes(room);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // 9. MANCHE SUIVANTE (HÔTE UNIQUEMENT)
  if (pathname === '/api/next-round' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token } = data;
      const room = rooms.get(code);

      if (!room || !isHost(room, playerId, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Seul l\'hôte peut lancer la manche suivante.' }));
        return;
      }

      room.lastActiveAt = Date.now();

      if (room.status === 'result') {
        room.round++;
        const aliveZozus = room.players.filter(p => room.zozuIds.includes(p.id) && !room.eliminatedIds.includes(p.id));
        assignMissionsForRoom(room, aliveZozus);

        // New topic sans répétition
        room.topic = pickTopicForRoom(room);

        room.status = 'revealing';
        room.revealedPlayerIds = [];
        room.revealDeadline = Date.now() + 60000;
        room.votes = {};
        console.log(`[ROOM ${code}] Next round started (Round ${room.round})`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, round: room.round }));
    });
    return;
  }

  // 10. RESTART ENTIRE GAME (HÔTE UNIQUEMENT)
  if (pathname === '/api/restart-game' && req.method === 'POST') {
    readJson((err, data) => {
      const code = (data.roomCode || '').toUpperCase().trim();
      const { playerId, token } = data;
      const room = rooms.get(code);

      if (!room || !isHost(room, playerId, token)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Seul l\'hôte peut redémarrer la partie.' }));
        return;
      }

      room.status = 'lobby';
      room.round = 1;
      room.eliminatedIds = [];
      room.votes = {};
      room.missions = {};
      room.zozuIds = [];
      room.revealedPlayerIds = [];
      room.lastResult = null;
      room.lastActiveAt = Date.now();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // 11. ÉTAT DU SALON (CONTINUOUS POLLING & SERVER TIMERS RESOLUTION)
  if (pathname === '/api/room-state' && req.method === 'GET') {
    const code = (parsedUrl.searchParams.get('code') || '').toUpperCase().trim();
    const playerId = parsedUrl.searchParams.get('playerId');
    const token = parsedUrl.searchParams.get('token');

    if (token && !checkTokenRateLimit(token)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Trop de requêtes pour ce joueur. Merci de patienter un instant !' }));
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Salon inexistant ou terminé.' }));
      return;
    }

    room.lastActiveAt = Date.now();
    transferHostIfNeeded(room);

    // Resolve server-side timers automatically
    const now = Date.now();
    if (room.status === 'revealing' && room.revealDeadline > 0 && now >= room.revealDeadline) {
      room.status = 'debating';
      room.debateEndsAt = now + 120000;
      console.log(`[ROOM ${code}] Reveal deadline passed -> Debating started.`);
    } else if (room.status === 'debating' && room.debateEndsAt > 0 && now >= room.debateEndsAt) {
      room.status = 'voting';
      room.voteEndsAt = now + 45000;
      room.votes = {};
      console.log(`[ROOM ${code}] Debate timer elapsed -> Voting started.`);
    } else if (room.status === 'voting' && room.voteEndsAt > 0 && now >= room.voteEndsAt) {
      tallyVotes(room);
      console.log(`[ROOM ${code}] Vote timer elapsed -> Tallied.`);
    }

    const isValidPlayer = verifyPlayer(room, playerId, token);
    const isPlayerZozu = isValidPlayer && room.zozuIds.includes(playerId);
    const isEnded = room.status === 'ended';

    // Compute remaining timer seconds
    let remainingTimer = 0;
    if (room.status === 'revealing') {
      remainingTimer = Math.max(0, Math.ceil((room.revealDeadline - now) / 1000));
    } else if (room.status === 'debating') {
      remainingTimer = Math.max(0, Math.ceil((room.debateEndsAt - now) / 1000));
    } else if (room.status === 'voting') {
      remainingTimer = Math.max(0, Math.ceil((room.voteEndsAt - now) / 1000));
    }

    const alivePlayersCount = room.players.filter(p => !room.eliminatedIds.includes(p.id)).length;
    const votesCount = Object.keys(room.votes).length;

    // Strict privacy sanitization:
    // NO zozuIds leaked, NO other players' roles or missions leaked.
    const sanitizedRoom = {
      code: room.code,
      status: room.status,
      round: room.round,
      topic: room.topic,
      hostId: room.hostId,
      isHost: isValidPlayer && room.hostId === playerId,
      zozuCount: room.zozuCount,
      players: room.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex || (idx + 1),
        isHost: p.id === room.hostId,
        eliminated: room.eliminatedIds.includes(p.id)
      })),
      isZozu: isPlayerZozu,
      mission: isPlayerZozu ? (room.missions[playerId] || null) : null,
      eliminatedIds: room.eliminatedIds,
      remainingTimer,
      hasVoted: isValidPlayer && room.votes[playerId] !== undefined,
      votesCount,
      alivePlayersCount,
      hasConfirmedReveal: isValidPlayer && room.revealedPlayerIds.includes(playerId),
      revealedCount: room.revealedPlayerIds.length,
      lastResult: room.lastResult || null,
      // Only reveal all Zozus when game is formally ended
      allZozus: isEnded ? room.players.filter(p => room.zozuIds.includes(p.id)).map(p => ({
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        mission: room.missions[p.id]
      })) : undefined
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, room: sanitizedRoom }));
    return;
  }

  // =========================================================================
  // --- STATIC FILE SERVING ---
  // =========================================================================
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(__dirname, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
    }

    if (ext === '.html' || filePath.endsWith('sw.js') || ext === '.json') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Erreur serveur');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`ZOZU running on port ${PORT}`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // or better: ["https://your-frontend.com"]
    methods: ["GET", "POST"]
  }
});

// In-memory stores (simple): agents, queue, pairings
const agents = {};       // { socketId: { name, busy } }
const waitingQueue = []; // [supplierSocketId, ...]
const pairings = {};     // pairings[supplier] = agent and pairings[agent] = supplier

function findFreeAgent() {
  return Object.keys(agents).find(id => agents[id].busy === false);
}

app.get('/health', (req, res) => res.json({ ok: true }));

io.on('connection', socket => {
  console.log('connected', socket.id);

  // Agent registers
  socket.on('agent-register', ({ name }) => {
    agents[socket.id] = { name: name || `Agent-${socket.id.slice(0,5)}`, busy: false };
    console.log('Agent registered', socket.id, agents[socket.id]);
    socket.emit('agent-registered', { name: agents[socket.id].name, queueLength: waitingQueue.length });
  });

  // Supplier requests a call
  socket.on('supplier-call', () => {
    console.log('Supplier request', socket.id);
    if (waitingQueue.includes(socket.id)) {
      socket.emit('queue-status', { position: waitingQueue.indexOf(socket.id) + 1 });
      return;
    }

    const freeAgentId = findFreeAgent();
    if (freeAgentId) {
      agents[freeAgentId].busy = true;
      pairings[socket.id] = freeAgentId;
      pairings[freeAgentId] = socket.id;
      io.to(freeAgentId).emit('incoming-call', { supplierId: socket.id });
      io.to(socket.id).emit('call-requested', { agentId: freeAgentId });
      console.log(`Assigned ${socket.id} -> ${freeAgentId}`);
    } else {
      waitingQueue.push(socket.id);
      socket.emit('queue-status', { position: waitingQueue.length });
      console.log(`Queued ${socket.id} at position ${waitingQueue.length}`);
    }
  });

  // Agent accepts a call
  socket.on('agent-accept', ({ supplierId }) => {
    if (!agents[socket.id]) return;
    // pair them
    pairings[supplierId] = socket.id;
    pairings[socket.id] = supplierId;
    agents[socket.id].busy = true;
    io.to(supplierId).emit('call-accepted', { agentId: socket.id });
    io.to(socket.id).emit('call-started', { supplierId });
    console.log(`Agent ${socket.id} accepted ${supplierId}`);
  });

  // Agent rejects a call
  socket.on('agent-reject', ({ supplierId }) => {
    if (agents[socket.id]) agents[socket.id].busy = false;
    const freeAgent = findFreeAgent();
    if (freeAgent) {
      agents[freeAgent].busy = true;
      pairings[supplierId] = freeAgent;
      pairings[freeAgent] = supplierId;
      io.to(freeAgent).emit('incoming-call', { supplierId });
      io.to(supplierId).emit('call-requested', { agentId: freeAgent });
    } else {
      if (!waitingQueue.includes(supplierId)) waitingQueue.push(supplierId);
      io.to(supplierId).emit('queue-status', { position: waitingQueue.indexOf(supplierId) + 1 });
    }
  });

  // WebRTC signaling relay (offer/answer/candidate)
  socket.on('webrtc-offer', ({ to, sdp }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, sdp });
  });

  socket.on('webrtc-answer', ({ to, sdp }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, sdp });
  });

  socket.on('webrtc-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc-candidate', { from: socket.id, candidate });
  });

  // End call
  socket.on('end-call', ({ partnerId }) => {
    const other = partnerId;
    if (agents[socket.id]) agents[socket.id].busy = false;
    if (agents[other]) agents[other].busy = false;

    if (pairings[socket.id]) delete pairings[socket.id];
    if (pairings[other]) delete pairings[other];

    io.to(other).emit('call-ended', { by: socket.id });

    // assign next waiting supplier to first free agent found
    const freeAgent = findFreeAgent();
    if (freeAgent && waitingQueue.length > 0) {
      const nextSupplier = waitingQueue.shift();
      if (nextSupplier) {
        agents[freeAgent].busy = true;
        pairings[freeAgent] = nextSupplier;
        pairings[nextSupplier] = freeAgent;
        io.to(freeAgent).emit('incoming-call', { supplierId: nextSupplier });
        io.to(nextSupplier).emit('call-requested', { agentId: freeAgent });
      }
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    if (agents[socket.id]) {
      const supplier = pairings[socket.id];
      if (supplier) {
        delete pairings[supplier];
        io.to(supplier).emit('agent-disconnected');
        const freeAgent = findFreeAgent();
        if (freeAgent) {
          agents[freeAgent].busy = true;
          pairings[freeAgent] = supplier;
          pairings[supplier] = freeAgent;
          io.to(freeAgent).emit('incoming-call', { supplierId: supplier });
          io.to(supplier).emit('call-requested', { agentId: freeAgent });
        } else {
          waitingQueue.push(supplier);
          io.to(supplier).emit('queue-status', { position: waitingQueue.indexOf(supplier) + 1 });
        }
      }
      delete agents[socket.id];
      delete pairings[socket.id];
      return;
    }

    const qIndex = waitingQueue.indexOf(socket.id);
    if (qIndex >= 0) waitingQueue.splice(qIndex, 1);

    const pairedAgent = pairings[socket.id];
    if (pairedAgent) {
      io.to(pairedAgent).emit('supplier-disconnected', { supplierId: socket.id });
      if (agents[pairedAgent]) agents[pairedAgent].busy = false;
      delete pairings[pairedAgent];
    }
    delete pairings[socket.id];
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Signaling server running on :${PORT}`));

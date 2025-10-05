const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// JSONBin configuration - USING YOUR CREDENTIALS
const JSONBIN_API_KEY = '$2a$10$nCvtrBD0oAjmgXA5JAjTJ.3O5cDYYn7t7QpgqevUchxQTb5V4mBOO';
const JSONBIN_BIN_ID = '68e223bc43b1c97be95ad96d';
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const JSONBIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Master-Key': JSONBIN_API_KEY,
  'X-Bin-Versioning': 'false'
};

// Initial data structure for JSONBin
const initialData = {
  rooms: {},
  users: {},
  chatHistory: {},
  messageReactions: {},
  roomThemes: {},
  lastUpdated: new Date().toISOString()
};

// Store active rooms and their users (in-memory for real-time operations)
const rooms = new Map();
const messageReactions = new Map();
const roomThemes = new Map();
const chatHistory = new Map();
const roomUsers = new Map();
const messageStatus = new Map();

// JSONBin Utility Functions
async function loadFromJSONBin() {
  try {
    console.log('Loading data from JSONBin...');
    const response = await fetch(JSONBIN_URL, {
      method: 'GET',
      headers: JSONBIN_HEADERS
    });
    
    if (!response.ok) {
      console.log('No existing data found in JSONBin, starting fresh...');
      return initialData;
    }
    
    const data = await response.json();
    console.log('Data successfully loaded from JSONBin');
    return data.record || initialData;
  } catch (error) {
    console.error('Error loading from JSONBin:', error);
    return initialData;
  }
}

async function saveToJSONBin(data) {
  try {
    const updateData = {
      ...data,
      lastUpdated: new Date().toISOString()
    };

    const response = await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: JSONBIN_HEADERS,
      body: JSON.stringify(updateData)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('Data successfully saved to JSONBin');
    return result;
  } catch (error) {
    console.error('Error saving to JSONBin:', error);
    throw error;
  }
}

// Initialize JSONBin data
let jsonBinData = initialData;

// Load data on server start
loadFromJSONBin().then(data => {
  jsonBinData = data;
  console.log('Server data initialized from JSONBin');
  
  // Load existing rooms and chat history into memory
  if (jsonBinData.rooms) {
    Object.keys(jsonBinData.rooms).forEach(pin => {
      const room = jsonBinData.rooms[pin];
      if (room.theme) {
        roomThemes.set(pin, room.theme);
      }
    });
  }
  
  if (jsonBinData.chatHistory) {
    Object.keys(jsonBinData.chatHistory).forEach(pin => {
      chatHistory.set(pin, jsonBinData.chatHistory[pin]);
    });
  }

  if (jsonBinData.messageReactions) {
    Object.keys(jsonBinData.messageReactions).forEach(reactionKey => {
      messageReactions.set(reactionKey, jsonBinData.messageReactions[reactionKey]);
    });
  }

  console.log(`Loaded ${Object.keys(jsonBinData.rooms).length} rooms from JSONBin`);
  console.log(`Loaded ${Object.keys(jsonBinData.users).length} users from JSONBin`);
  console.log(`Loaded ${Object.keys(jsonBinData.chatHistory).length} chat histories from JSONBin`);
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', async (data) => {
    const { pin, userName } = data;
    
    // Leave any previous rooms
    if (socket.room) {
      socket.leave(socket.room);
    }
    
    // Join the new room
    socket.join(pin);
    socket.room = pin;
    socket.userName = userName;
    
    // Add user to room
    if (!rooms.has(pin)) {
      rooms.set(pin, new Set());
    }
    rooms.get(pin).add(socket.id);
    
    // Add user to room users
    if (!roomUsers.has(pin)) {
      roomUsers.set(pin, []);
    }
    roomUsers.get(pin).push({ socketId: socket.id, userName: userName });
    
    // Save user to JSONBin
    if (!jsonBinData.users[userName]) {
      jsonBinData.users[userName] = {
        joinedAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        roomsJoined: [],
        socketId: socket.id
      };
    } else {
      jsonBinData.users[userName].lastActive = new Date().toISOString();
      jsonBinData.users[userName].socketId = socket.id;
    }
    
    // Update user activity and rooms
    if (!jsonBinData.users[userName].roomsJoined.includes(pin)) {
      jsonBinData.users[userName].roomsJoined.push(pin);
    }
    
    // Save room to JSONBin
    if (!jsonBinData.rooms[pin]) {
      jsonBinData.rooms[pin] = {
        createdAt: new Date().toISOString(),
        createdBy: userName,
        userCount: 1,
        theme: 'default',
        lastActive: new Date().toISOString()
      };
    } else {
      // Update room user count
      jsonBinData.rooms[pin].userCount = rooms.get(pin).size;
      jsonBinData.rooms[pin].lastActive = new Date().toISOString();
    }
    
    // Send current theme if exists
    if (roomThemes.has(pin)) {
      socket.emit('theme_changed', { theme: roomThemes.get(pin) });
    } else if (jsonBinData.roomThemes && jsonBinData.roomThemes[pin]) {
      roomThemes.set(pin, jsonBinData.roomThemes[pin]);
      socket.emit('theme_changed', { theme: jsonBinData.roomThemes[pin] });
    }
    
    // Send user count update
    io.to(pin).emit('user_count_update', { count: rooms.get(pin).size });
    
    // Send current users list
    io.to(pin).emit('current_users', { users: roomUsers.get(pin) });
    
    // Send chat history if exists
    if (chatHistory.has(pin)) {
      socket.emit('chat_history', { messages: chatHistory.get(pin) });
    } else if (jsonBinData.chatHistory && jsonBinData.chatHistory[pin]) {
      chatHistory.set(pin, jsonBinData.chatHistory[pin]);
      socket.emit('chat_history', { messages: jsonBinData.chatHistory[pin] });
    }
    
    // Notify others in the room
    socket.to(pin).emit('user_joined', { 
      message: `${userName} joined the chat`,
      userName: userName
    });

    // Update message status for all messages when user joins
    if (chatHistory.has(pin)) {
      chatHistory.get(pin).forEach(message => {
        if (message.type === 'received') {
          if (!messageStatus.has(message.messageId)) {
            messageStatus.set(message.messageId, {});
          }
          messageStatus.get(message.messageId).delivered = true;
          
          const sender = roomUsers.get(pin).find(user => user.userName === message.sender);
          if (sender) {
            io.to(sender.socketId).emit('message_status_update', {
              messageId: message.messageId,
              status: 'delivered'
            });
          }
        }
      });
    }
    
    // Save to JSONBin
    try {
      await saveToJSONBin(jsonBinData);
    } catch (error) {
      console.error('Failed to save to JSONBin:', error);
    }
    
    console.log(`User ${socket.id} (${userName}) joined room ${pin}`);
  });

  socket.on('get_current_users', (data) => {
    const { pin } = data;
    if (roomUsers.has(pin)) {
      socket.emit('current_users', { users: roomUsers.get(pin) });
    }
  });

  socket.on('send_message', async (data) => {
    const { pin, message, timestamp, messageId, sender, replyTo } = data;
    
    // Store message in memory
    if (!chatHistory.has(pin)) {
      chatHistory.set(pin, []);
    }
    
    const messageData = {
      message, 
      sender, 
      timestamp, 
      messageId, 
      type: 'received', 
      replyTo,
      sentAt: new Date().toISOString()
    };
    
    chatHistory.get(pin).push(messageData);
    
    // Keep only last 100 messages in memory
    if (chatHistory.get(pin).length > 100) {
      chatHistory.set(pin, chatHistory.get(pin).slice(-100));
    }

    // Store message in JSONBin
    if (!jsonBinData.chatHistory[pin]) {
      jsonBinData.chatHistory[pin] = [];
    }
    
    jsonBinData.chatHistory[pin].push(messageData);
    
    // Keep only last 200 messages in JSONBin to prevent excessive storage
    if (jsonBinData.chatHistory[pin].length > 200) {
      jsonBinData.chatHistory[pin] = jsonBinData.chatHistory[pin].slice(-200);
    }

    // Initialize status for this message
    if (!messageStatus.has(messageId)) {
      messageStatus.set(messageId, {});
    }
    
    // Broadcast message to others in the room
    socket.to(pin).emit('message', {
      message: message,
      sender: sender,
      timestamp: timestamp,
      messageId: messageId,
      replyTo: replyTo
    });

    // Update status to delivered if there are other users
    if (rooms.has(pin) && rooms.get(pin).size > 1) {
      messageStatus.get(messageId).delivered = true;
      socket.emit('message_status_update', {
        messageId: messageId,
        status: 'delivered'
      });
    }
    
    // Save to JSONBin
    try {
      await saveToJSONBin(jsonBinData);
    } catch (error) {
      console.error('Failed to save message to JSONBin:', error);
    }
  });

  socket.on('message_delivered', (data) => {
    const { pin, messageId } = data;
    
    if (messageStatus.has(messageId)) {
      messageStatus.get(messageId).delivered = true;
      
      const message = chatHistory.get(pin)?.find(msg => msg.messageId === messageId);
      if (message) {
        const sender = roomUsers.get(pin)?.find(user => user.userName === message.sender);
        if (sender) {
          io.to(sender.socketId).emit('message_status_update', {
            messageId: messageId,
            status: 'delivered'
          });
        }
      }
    }
  });

  socket.on('message_reaction', async (data) => {
    const { pin, messageId, reaction } = data;
    
    // Store reaction in memory
    const reactionKey = `${pin}-${messageId}`;
    if (!messageReactions.has(reactionKey)) {
      messageReactions.set(reactionKey, {});
    }
    
    const reactions = messageReactions.get(reactionKey);
    reactions[reaction] = (reactions[reaction] || 0) + 1;
    
    // Store reaction in JSONBin
    if (!jsonBinData.messageReactions) {
      jsonBinData.messageReactions = {};
    }
    
    if (!jsonBinData.messageReactions[reactionKey]) {
      jsonBinData.messageReactions[reactionKey] = {};
    }
    
    jsonBinData.messageReactions[reactionKey][reaction] = 
      (jsonBinData.messageReactions[reactionKey][reaction] || 0) + 1;
    
    // Broadcast reaction to room
    io.to(pin).emit('message_reaction', {
      messageId: messageId,
      reaction: reaction,
      count: jsonBinData.messageReactions[reactionKey][reaction]
    });
    
    // Save to JSONBin
    try {
      await saveToJSONBin(jsonBinData);
    } catch (error) {
      console.error('Failed to save reaction to JSONBin:', error);
    }
  });

  socket.on('unsend_message', async (data) => {
    const { pin, messageId } = data;
    
    // Remove message from memory
    if (chatHistory.has(pin)) {
      chatHistory.set(pin, chatHistory.get(pin).filter(msg => msg.messageId !== messageId));
    }
    
    // Remove message from JSONBin
    if (jsonBinData.chatHistory[pin]) {
      jsonBinData.chatHistory[pin] = jsonBinData.chatHistory[pin].filter(
        msg => msg.messageId !== messageId
      );
    }
    
    // Remove message status
    if (messageStatus.has(messageId)) {
      messageStatus.delete(messageId);
    }
    
    // Remove reactions for this message
    const reactionKey = `${pin}-${messageId}`;
    if (messageReactions.has(reactionKey)) {
      messageReactions.delete(reactionKey);
    }
    if (jsonBinData.messageReactions && jsonBinData.messageReactions[reactionKey]) {
      delete jsonBinData.messageReactions[reactionKey];
    }
    
    // Broadcast unsend to all users in the room
    io.to(pin).emit('message_unsent', {
      messageId: messageId
    });
    
    // Save to JSONBin
    try {
      await saveToJSONBin(jsonBinData);
    } catch (error) {
      console.error('Failed to save unsend action to JSONBin:', error);
    }
    
    console.log(`Message ${messageId} unsent in room ${pin}`);
  });

  socket.on('typing_start', (data) => {
    const { pin, userName } = data;
    socket.to(pin).emit('typing_start', { userName: userName });
  });

  socket.on('typing_stop', (data) => {
    const { pin } = data;
    socket.to(pin).emit('typing_stop');
  });

  socket.on('change_theme', async (data) => {
    const { pin, theme } = data;
    
    // Store theme in memory
    roomThemes.set(pin, theme);
    
    // Store theme in JSONBin
    if (!jsonBinData.roomThemes) {
      jsonBinData.roomThemes = {};
    }
    jsonBinData.roomThemes[pin] = theme;
    
    if (jsonBinData.rooms[pin]) {
      jsonBinData.rooms[pin].theme = theme;
    }
    
    // Broadcast theme change to all users in the room
    io.to(pin).emit('theme_changed', { theme: theme });
    
    // Save to JSONBin
    try {
      await saveToJSONBin(jsonBinData);
    } catch (error) {
      console.error('Failed to save theme to JSONBin:', error);
    }
  });

  socket.on('delete_room', async (data) => {
    const { pin } = data;
    
    // Clear room data from memory
    if (rooms.has(pin)) {
      rooms.delete(pin);
    }
    if (roomThemes.has(pin)) {
      roomThemes.delete(pin);
    }
    if (chatHistory.has(pin)) {
      chatHistory.delete(pin);
    }
    if (roomUsers.has(pin)) {
      roomUsers.delete(pin);
    }
    
    // Clear room data from JSONBin
    if (jsonBinData.rooms[pin]) {
      delete jsonBinData.rooms[pin];
    }
    if (jsonBinData.chatHistory[pin]) {
      delete jsonBinData.chatHistory[pin];
    }
    if (jsonBinData.roomThemes && jsonBinData.roomThemes[pin]) {
      delete jsonBinData.roomThemes[pin];
    }
    
    // Clear message status for this room
    Array.from(messageStatus.keys()).forEach(messageId => {
      messageStatus.delete(messageId);
    });
    
    // Notify all users in the room
    io.to(pin).emit('room_deleted');
    
    // Save to JSONBin
    try {
      await saveToJSONBin(jsonBinData);
    } catch (error) {
      console.error('Failed to save room deletion to JSONBin:', error);
    }
    
    console.log(`Room ${pin} deleted`);
  });

  socket.on('leave_room', async (data) => {
    const { pin } = data;
    
    if (socket.room === pin) {
      // Remove user from room
      if (rooms.has(pin)) {
        rooms.get(pin).delete(socket.id);
        
        // Remove user from room users
        if (roomUsers.has(pin)) {
          roomUsers.set(pin, roomUsers.get(pin).filter(user => user.socketId !== socket.id));
          
          // Update current users list
          io.to(pin).emit('current_users', { users: roomUsers.get(pin) });
        }
        
        // Update user count
        io.to(pin).emit('user_count_update', { count: rooms.get(pin).size });
        
        // Update JSONBin room user count
        if (jsonBinData.rooms[pin]) {
          jsonBinData.rooms[pin].userCount = rooms.get(pin).size;
          jsonBinData.rooms[pin].lastActive = new Date().toISOString();
        }
        
        // If room is empty, delete it after a delay
        if (rooms.get(pin).size === 0) {
          setTimeout(() => {
            if (rooms.has(pin) && rooms.get(pin).size === 0) {
              rooms.delete(pin);
              if (roomThemes.has(pin)) {
                roomThemes.delete(pin);
              }
              if (roomUsers.has(pin)) {
                roomUsers.delete(pin);
              }
              console.log(`Room ${pin} cleared (no users)`);
            }
          }, 30000);
        } else {
          // Notify others that user left
          socket.to(pin).emit('user_left', { 
            message: `${socket.userName} left the chat`,
            userName: socket.userName
          });
        }
      }
      
      socket.leave(pin);
      socket.room = null;
      
      // Save to JSONBin
      try {
        await saveToJSONBin(jsonBinData);
      } catch (error) {
        console.error('Failed to save leave room to JSONBin:', error);
      }
    }
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.room) {
      // Remove user from room
      if (rooms.has(socket.room)) {
        rooms.get(socket.room).delete(socket.id);
        
        // Remove user from room users
        if (roomUsers.has(socket.room)) {
          roomUsers.set(socket.room, roomUsers.get(socket.room).filter(user => user.socketId !== socket.id));
          
          // Update current users list
          io.to(socket.room).emit('current_users', { users: roomUsers.get(socket.room) });
        }
        
        // Update user count
        io.to(socket.room).emit('user_count_update', { count: rooms.get(socket.room).size });
        
        // Update JSONBin room user count
        if (jsonBinData.rooms[socket.room]) {
          jsonBinData.rooms[socket.room].userCount = rooms.get(socket.room).size;
          jsonBinData.rooms[socket.room].lastActive = new Date().toISOString();
        }
        
        // If room is empty, delete it after a delay
        if (rooms.get(socket.room).size === 0) {
          setTimeout(() => {
            if (rooms.has(socket.room) && rooms.get(socket.room).size === 0) {
              rooms.delete(socket.room);
              if (roomThemes.has(socket.room)) {
                roomThemes.delete(socket.room);
              }
              if (roomUsers.has(socket.room)) {
                roomUsers.delete(socket.room);
              }
              console.log(`Room ${socket.room} cleared (no users)`);
            }
          }, 30000);
        } else {
          // Notify others that user left
          socket.to(socket.room).emit('user_left', { 
            message: `${socket.userName} left the chat`,
            userName: socket.userName
          });
        }
      }
      
      // Save to JSONBin
      try {
        await saveToJSONBin(jsonBinData);
      } catch (error) {
        console.error('Failed to save disconnect to JSONBin:', error);
      }
    }
  });
});

// API endpoint to get statistics
app.get('/api/stats', async (req, res) => {
  try {
    const stats = {
      totalRooms: Object.keys(jsonBinData.rooms).length,
      totalUsers: Object.keys(jsonBinData.users).length,
      totalMessages: Object.keys(jsonBinData.chatHistory).reduce((acc, pin) => 
        acc + (jsonBinData.chatHistory[pin]?.length || 0), 0),
      activeRooms: rooms.size,
      lastUpdated: jsonBinData.lastUpdated
    };
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

// API endpoint to get room history
app.get('/api/room/:pin/history', async (req, res) => {
  try {
    const { pin } = req.params;
    const history = jsonBinData.chatHistory[pin] || [];
    res.json({ pin, messages: history });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get room history' });
  }
});

// API endpoint to get all rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const roomsList = Object.keys(jsonBinData.rooms).map(pin => ({
      pin,
      ...jsonBinData.rooms[pin]
    }));
    
    res.json({ rooms: roomsList });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get rooms list' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    jsonBinStatus: 'Connected',
    activeConnections: io.engine.clientsCount
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 JSONBin integration enabled`);
  console.log(`🔑 Bin ID: ${JSONBIN_BIN_ID}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/api/health`);
});

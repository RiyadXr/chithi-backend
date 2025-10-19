const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// JSONBin configuration
const JSONBIN_BIN_ID = '68f5421743b1c97be971bc06';
const JSONBIN_MASTER_KEY = '$2a$10$nCvtrBD0oAjmgXA5JAjTJ.3O5cDYYn7t7QpgqevUchxQTb5V4mBOO';
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const JSONBIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Master-Key': JSONBIN_MASTER_KEY
};

// Store active rooms and their users (in-memory for real-time operations)
const rooms = new Map();
const messageReactions = new Map();
const roomThemes = new Map();
const chatHistory = new Map();
const roomUsers = new Map();
const messageStatus = new Map();

// Initialize JSONBin data
let binData = {
  rooms: []
};

// Load data from JSONBin on server start
async function loadBinData() {
  try {
    const response = await fetch(JSONBIN_URL, {
      method: 'GET',
      headers: JSONBIN_HEADERS
    });
    
    if (response.ok) {
      const data = await response.json();
      binData = data.record;
      console.log('Data loaded from JSONBin');
      
      // Restore active rooms to memory
      binData.rooms.forEach(room => {
        if (room.status === 'active') {
          chatHistory.set(room.pin, room.messages || []);
          roomThemes.set(room.pin, room.theme || 'default');
        }
      });
    } else {
      console.log('No existing data found in JSONBin, starting fresh');
    }
  } catch (error) {
    console.error('Error loading data from JSONBin:', error);
  }
}

// Save data to JSONBin
async function saveToBin() {
  try {
    // Update binData with current state
    binData.rooms = Array.from(rooms.keys()).map(pin => {
      const existingRoom = binData.rooms.find(r => r.pin === pin) || {};
      return {
        pin: pin,
        createdAt: existingRoom.createdAt || new Date().toISOString(),
        messages: chatHistory.get(pin) || [],
        theme: roomThemes.get(pin) || 'default',
        status: 'active',
        lastActive: new Date().toISOString(),
        userCount: rooms.get(pin)?.size || 0
      };
    });

    // Also update rooms that are in binData but not currently active (preserve deleted rooms)
    const activePins = Array.from(rooms.keys());
    binData.rooms.forEach(room => {
      if (!activePins.includes(room.pin) && room.status === 'active') {
        room.status = 'inactive';
        room.lastActive = new Date().toISOString();
      }
    });

    const response = await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: JSONBIN_HEADERS,
      body: JSON.stringify(binData)
    });

    if (response.ok) {
      console.log('Data saved to JSONBin');
    } else {
      console.error('Failed to save data to JSONBin');
    }
  } catch (error) {
    console.error('Error saving data to JSONBin:', error);
  }
}

// Load data when server starts
loadBinData();

// Auto-save to JSONBin every 30 seconds
setInterval(saveToBin, 30000);

// Also save on graceful shutdown
process.on('SIGINT', async () => {
  console.log('Saving data before shutdown...');
  await saveToBin();
  process.exit(0);
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', (data) => {
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
      
      // Add new room to binData if it doesn't exist
      if (!binData.rooms.find(r => r.pin === pin)) {
        binData.rooms.push({
          pin: pin,
          createdAt: new Date().toISOString(),
          messages: [],
          theme: 'default',
          status: 'active',
          lastActive: new Date().toISOString(),
          userCount: 1
        });
      } else {
        // Update existing room status to active
        const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
        if (roomIndex !== -1) {
          binData.rooms[roomIndex].status = 'active';
          binData.rooms[roomIndex].lastActive = new Date().toISOString();
        }
      }
    }
    rooms.get(pin).add(socket.id);
    
    // Add user to room users
    if (!roomUsers.has(pin)) {
      roomUsers.set(pin, []);
    }
    roomUsers.get(pin).push({ socketId: socket.id, userName: userName });
    
    // Send current theme if exists
    if (roomThemes.has(pin)) {
      socket.emit('theme_changed', { theme: roomThemes.get(pin) });
    }
    
    // Send user count update
    io.to(pin).emit('user_count_update', { count: rooms.get(pin).size });
    
    // Send current users list
    io.to(pin).emit('current_users', { users: roomUsers.get(pin) });
    
    // Send chat history if exists
    if (chatHistory.has(pin)) {
      socket.emit('chat_history', { messages: chatHistory.get(pin) });
    }
    
    // Notify others in the room
    socket.to(pin).emit('user_joined', { 
      message: 'A user joined the chat',
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
    
    // Update room data in binData
    const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
    if (roomIndex !== -1) {
      binData.rooms[roomIndex].userCount = rooms.get(pin).size;
      binData.rooms[roomIndex].lastActive = new Date().toISOString();
    }
    
    console.log(`User ${socket.id} (${userName}) joined room ${pin}`);
  });

  socket.on('get_current_users', (data) => {
    const { pin } = data;
    if (roomUsers.has(pin)) {
      socket.emit('current_users', { users: roomUsers.get(pin) });
    }
  });

  socket.on('send_message', (data) => {
    const { pin, message, timestamp, messageId, sender, replyTo } = data;
    
    // Store message in history
    if (!chatHistory.has(pin)) {
      chatHistory.set(pin, []);
    }
    
    const messageData = {
      message, sender, timestamp, messageId, type: 'received', replyTo
    };
    
    chatHistory.get(pin).push(messageData);
    
    // Keep only last 100 messages
    if (chatHistory.get(pin).length > 100) {
      chatHistory.set(pin, chatHistory.get(pin).slice(-100));
    }

    // Initialize status for this message
    if (!messageStatus.has(messageId)) {
      messageStatus.set(messageId, {});
    }
    
    // Update binData with new message
    const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
    if (roomIndex !== -1) {
      binData.rooms[roomIndex].messages = chatHistory.get(pin);
      binData.rooms[roomIndex].lastActive = new Date().toISOString();
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

  socket.on('message_reaction', (data) => {
    const { pin, messageId, reaction } = data;
    
    const reactionKey = `${pin}-${messageId}`;
    if (!messageReactions.has(reactionKey)) {
      messageReactions.set(reactionKey, {});
    }
    
    const reactions = messageReactions.get(reactionKey);
    reactions[reaction] = (reactions[reaction] || 0) + 1;
    
    io.to(pin).emit('message_reaction', {
      messageId: messageId,
      reaction: reaction
    });
  });

  socket.on('unsend_message', (data) => {
    const { pin, messageId } = data;
    
    if (chatHistory.has(pin)) {
      chatHistory.set(pin, chatHistory.get(pin).filter(msg => msg.messageId !== messageId));
      
      // Update binData
      const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
      if (roomIndex !== -1) {
        binData.rooms[roomIndex].messages = chatHistory.get(pin);
      }
    }
    
    if (messageStatus.has(messageId)) {
      messageStatus.delete(messageId);
    }
    
    io.to(pin).emit('message_unsent', {
      messageId: messageId
    });
    
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

  socket.on('change_theme', (data) => {
    const { pin, theme } = data;
    
    roomThemes.set(pin, theme);
    
    // Update binData
    const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
    if (roomIndex !== -1) {
      binData.rooms[roomIndex].theme = theme;
    }
    
    io.to(pin).emit('theme_changed', { theme: theme });
  });

  socket.on('delete_room', (data) => {
    const { pin } = data;
    
    // Mark room as deleted in binData (don't remove from binData)
    const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
    if (roomIndex !== -1) {
      binData.rooms[roomIndex].status = 'deleted';
      binData.rooms[roomIndex].deletedAt = new Date().toISOString();
    }
    
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
    
    Array.from(messageStatus.keys()).forEach(messageId => {
      messageStatus.delete(messageId);
    });
    
    io.to(pin).emit('room_deleted');
    
    console.log(`Room ${pin} deleted`);
  });

  socket.on('leave_room', (data) => {
    const { pin } = data;
    
    if (socket.room === pin) {
      if (rooms.has(pin)) {
        rooms.get(pin).delete(socket.id);
        
        if (roomUsers.has(pin)) {
          roomUsers.set(pin, roomUsers.get(pin).filter(user => user.socketId !== socket.id));
          io.to(pin).emit('current_users', { users: roomUsers.get(pin) });
        }
        
        io.to(pin).emit('user_count_update', { count: rooms.get(pin).size });
        
        // Update user count in binData
        const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
        if (roomIndex !== -1) {
          binData.rooms[roomIndex].userCount = rooms.get(pin).size;
          binData.rooms[roomIndex].lastActive = new Date().toISOString();
        }
        
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
              
              // Mark room as inactive in binData
              const roomIndex = binData.rooms.findIndex(r => r.pin === pin);
              if (roomIndex !== -1) {
                binData.rooms[roomIndex].status = 'inactive';
              }
              
              console.log(`Room ${pin} cleared (no users)`);
            }
          }, 30000);
        } else {
          socket.to(pin).emit('user_left', { 
            message: 'A user left the chat',
            userName: socket.userName
          });
        }
      }
      
      socket.leave(pin);
      socket.room = null;
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.room) {
      if (rooms.has(socket.room)) {
        rooms.get(socket.room).delete(socket.id);
        
        if (roomUsers.has(socket.room)) {
          roomUsers.set(socket.room, roomUsers.get(socket.room).filter(user => user.socketId !== socket.id));
          io.to(socket.room).emit('current_users', { users: roomUsers.get(socket.room) });
        }
        
        io.to(socket.room).emit('user_count_update', { count: rooms.get(socket.room).size });
        
        // Update user count in binData
        const roomIndex = binData.rooms.findIndex(r => r.pin === socket.room);
        if (roomIndex !== -1) {
          binData.rooms[roomIndex].userCount = rooms.get(socket.room).size;
          binData.rooms[roomIndex].lastActive = new Date().toISOString();
        }
        
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
              
              // Mark room as inactive in binData
              const roomIndex = binData.rooms.findIndex(r => r.pin === socket.room);
              if (roomIndex !== -1) {
                binData.rooms[roomIndex].status = 'inactive';
              }
              
              console.log(`Room ${socket.room} cleared (no users)`);
            }
          }, 30000);
        } else {
          socket.to(socket.room).emit('user_left', { 
            message: 'A user left the chat',
            userName: socket.userName
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

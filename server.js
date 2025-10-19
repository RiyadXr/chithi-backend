const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');

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
const JSONBIN_API_URL = 'https://api.jsonbin.io/v3/b';
const JSONBIN_MASTER_KEY = '$2a$10$nCvtrBD0oAjmgXA5JAjTJ.3O5cDYYn7t7QpgqevUchxQTb5V4mBOO';
const JSONBIN_BIN_ID = '68e223bc43b1c97be95ad96d';

// Store active rooms and their users
const rooms = new Map();
// Store message reactions
const messageReactions = new Map();
// Store room themes
const roomThemes = new Map();
// Store chat history
const chatHistory = new Map();
// Store room users with names
const roomUsers = new Map();
// Store message status (sent, delivered, seen)
const messageStatus = new Map();

// Load data from JSONBin on server start
async function loadFromJSONBin() {
  try {
    const response = await axios.get(`${JSONBIN_API_URL}/${JSONBIN_BIN_ID}/latest`, {
      headers: {
        'X-Master-Key': JSONBIN_MASTER_KEY
      }
    });

    const data = response.data.record;
    
    // Load active chat history
    if (data.activeChatHistory) {
      Object.entries(data.activeChatHistory).forEach(([pin, messages]) => {
        chatHistory.set(pin, messages);
      });
    }

    // Load message reactions
    if (data.activeMessageReactions) {
      Object.entries(data.activeMessageReactions).forEach(([key, reaction]) => {
        messageReactions.set(key, reaction);
      });
    }

    // Load room themes
    if (data.activeRoomThemes) {
      Object.entries(data.activeRoomThemes).forEach(([pin, theme]) => {
        roomThemes.set(pin, theme);
      });
    }

    console.log('Data loaded successfully from JSONBin');
  } catch (error) {
    console.log('No existing data found in JSONBin or error loading:', error.message);
  }
}

// Save data to JSONBin
async function saveToJSONBin() {
  try {
    // Convert Maps to objects for JSON serialization
    const activeChatHistory = {};
    chatHistory.forEach((messages, pin) => {
      activeChatHistory[pin] = messages;
    });

    const activeMessageReactions = {};
    messageReactions.forEach((reaction, key) => {
      activeMessageReactions[key] = reaction;
    });

    const activeRoomThemes = {};
    roomThemes.forEach((theme, pin) => {
      activeRoomThemes[pin] = theme;
    });

    const activeRooms = {};
    rooms.forEach((users, pin) => {
      activeRooms[pin] = Array.from(users);
    });

    const activeRoomUsers = {};
    roomUsers.forEach((users, pin) => {
      activeRoomUsers[pin] = users;
    });

    const dataToSave = {
      activeRooms,
      activeRoomUsers,
      activeChatHistory,
      activeMessageReactions,
      activeRoomThemes,
      lastUpdated: new Date().toISOString()
    };

    await axios.put(`${JSONBIN_API_URL}/${JSONBIN_BIN_ID}`, dataToSave, {
      headers: {
        'X-Master-Key': JSONBIN_MASTER_KEY,
        'Content-Type': 'application/json'
      }
    });

    console.log('Data saved successfully to JSONBin');
  } catch (error) {
    console.error('Error saving to JSONBin:', error.message);
  }
}

// Debounced save function to prevent too many API calls
let saveTimeout;
function debouncedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveToJSONBin, 2000); // Save after 2 seconds of inactivity
}

// Initialize by loading data
loadFromJSONBin();

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
    }
    rooms.get(pin).add(socket.id);
    
    // Add user to room users
    if (!roomUsers.has(pin)) {
      roomUsers.set(pin, []);
    }
    
    // Check if user already exists in room
    const existingUserIndex = roomUsers.get(pin).findIndex(user => user.socketId === socket.id);
    if (existingUserIndex === -1) {
      roomUsers.get(pin).push({ 
        socketId: socket.id, 
        userName: userName,
        joinedAt: new Date().toISOString()
      });
    }
    
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
          // Update status to delivered for all received messages
          if (!messageStatus.has(message.messageId)) {
            messageStatus.set(message.messageId, {});
          }
          messageStatus.get(message.messageId).delivered = true;
          
          // Notify sender about delivery
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
    debouncedSave();
    
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
      message, 
      sender, 
      timestamp, 
      messageId, 
      type: 'received', 
      replyTo,
      sentAt: new Date().toISOString(),
      pin: pin
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
    debouncedSave();
  });

  socket.on('message_delivered', (data) => {
    const { pin, messageId } = data;
    
    if (messageStatus.has(messageId)) {
      messageStatus.get(messageId).delivered = true;
      
      // Notify sender about delivery
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
    
    // Store reaction
    const reactionKey = `${pin}-${messageId}`;
    if (!messageReactions.has(reactionKey)) {
      messageReactions.set(reactionKey, {});
    }
    
    const reactions = messageReactions.get(reactionKey);
    reactions[reaction] = (reactions[reaction] || 0) + 1;
    
    // Broadcast reaction to room
    io.to(pin).emit('message_reaction', {
      messageId: messageId,
      reaction: reaction
    });

    // Save to JSONBin
    debouncedSave();
  });

  socket.on('unsend_message', (data) => {
    const { pin, messageId } = data;
    
    // Remove message from history
    if (chatHistory.has(pin)) {
      chatHistory.set(pin, chatHistory.get(pin).filter(msg => msg.messageId !== messageId));
    }
    
    // Remove message status
    if (messageStatus.has(messageId)) {
      messageStatus.delete(messageId);
    }
    
    // Broadcast unsend to all users in the room
    io.to(pin).emit('message_unsent', {
      messageId: messageId
    });
    
    // Save to JSONBin
    debouncedSave();
    
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
    
    // Store theme for the room
    roomThemes.set(pin, theme);
    
    // Broadcast theme change to all users in the room
    io.to(pin).emit('theme_changed', { theme: theme });

    // Save to JSONBin
    debouncedSave();
  });

  socket.on('delete_room', (data) => {
    const { pin } = data;
    
    // Clear room data
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
    
    // Clear message status for this room
    Array.from(messageStatus.keys()).forEach(messageId => {
      messageStatus.delete(messageId);
    });
    
    // Notify all users in the room
    io.to(pin).emit('room_deleted');
    
    // Save to JSONBin
    debouncedSave();
    
    console.log(`Room ${pin} deleted`);
  });

  socket.on('leave_room', (data) => {
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
              
              // Save to JSONBin
              debouncedSave();
            }
          }, 30000); // Wait 30 seconds before clearing empty room
        } else {
          // Notify others that user left
          socket.to(pin).emit('user_left', { 
            message: 'A user left the chat',
            userName: socket.userName
          });
        }
      }
      
      socket.leave(pin);
      socket.room = null;
      
      // Save to JSONBin
      debouncedSave();
    }
  });

  socket.on('disconnect', () => {
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
              
              // Save to JSONBin
              debouncedSave();
            }
          }, 30000); // Wait 30 seconds before clearing empty room
        } else {
          // Notify others that user left
          socket.to(socket.room).emit('user_left', { 
            message: 'A user left the chat',
            userName: socket.userName
          });
        }
      }
      
      // Save to JSONBin
      debouncedSave();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

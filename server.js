const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// ========== CORS configuration ==========
const allowedOrigins = [
    "https://testing-chat-production.up.railway.app",
    "http://localhost:3000"
];

app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
}));

// ========== Force HTTPS redirect ==========
app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === 'production') {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});

app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static('uploads'));

// Create uploads folder if not exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// File upload setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

const server = http.createServer(app);

// ========== Socket.io configuration ==========
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["my-custom-header"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// ========== Data Stores ==========
const users = new Map(); // userId -> {socketId, name, profilePic, deviceId}
const userNames = new Map(); // name -> userId (for uniqueness)
const userDevices = new Map(); // deviceId -> userId (for device tracking)
const offlineMessages = new Map(); // userId -> [messages] (store offline messages)

// ========== GROUP CHAT DATA STORES ==========
const groups = new Map(); // groupId -> {name, description, icon, createdBy, createdAt, members, admins, type, settings}
const groupMessages = new Map(); // groupId -> [messages]

// ========== FRIEND REQUEST SYSTEM ==========
const friendRequests = new Map(); // requestId -> {fromUserId, toUserId, status, timestamp}
const userFriends = new Map(); // userId -> Set of friendIds
const userPendingRequests = new Map(); // userId -> Set of requestIds (sent/received)

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    const fileUrl = `/uploads/${file.filename}`;
    res.json({ 
        success: true, 
        fileUrl: fileUrl,
        fileName: file.originalname,
        fileType: file.mimetype
    });
});

io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);

    // ========== Get all users for search ==========
    socket.on('get-all-users', () => {
        const allUsers = [];
        users.forEach((value, key) => {
            allUsers.push({
                userId: key,
                name: value.name,
                profilePic: value.profilePic
            });
        });
        socket.emit('all-users', allUsers);
    });

    // ========== Search users ==========
    socket.on('search-users', (data) => {
        const { query, currentUserId } = data;
        
        const results = [];
        users.forEach((value, key) => {
            if (key === currentUserId) return;
            
            const nameMatch = value.name.toLowerCase().includes(query.toLowerCase());
            const idMatch = key.toLowerCase().includes(query.toLowerCase());
            
            if (nameMatch || idMatch) {
                results.push({
                    userId: key,
                    name: value.name,
                    profilePic: value.profilePic
                });
            }
        });
        
        socket.emit('search-results', results);
    });

    // ========== Check username uniqueness ==========
    socket.on('check-username', (data) => {
        const { name, userId, deviceId } = data;
        
        const userDeviceId = deviceId || userId.split('_')[1] || userId;
        
        if (userNames.has(name)) {
            const existingUserId = userNames.get(name);
            const existingDeviceId = existingUserId.split('_')[1] || existingUserId;
            
            if (existingDeviceId === userDeviceId) {
                socket.emit('username-check-result', false);
            } else {
                socket.emit('username-check-result', true);
            }
        } else {
            socket.emit('username-check-result', false);
        }
    });

    // ========== User login ==========
    socket.on('user-login', (data) => {
        const { userId, name, profilePic } = data;
        
        const deviceId = userId.split('_')[1] || userId;
        
        if (userDevices.has(deviceId)) {
            const oldUserId = userDevices.get(deviceId);
            if (oldUserId !== userId) {
                socket.emit('login-error', 'This device already has a different user. Please use another device.');
                return;
            }
        }
        
        if (users.has(userId)) {
            const oldSocketId = users.get(userId).socketId;
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('force-disconnect');
                users.delete(userId);
            }
        }
        
        users.set(userId, {
            socketId: socket.id,
            name: name,
            profilePic: profilePic || null,
            deviceId: deviceId
        });
        
        userNames.set(name, userId);
        userDevices.set(deviceId, userId);
        
        socket.join(userId);
        
        const onlineUsers = [];
        users.forEach((value, key) => {
            if (key !== userId) {
                onlineUsers.push({
                    userId: key,
                    name: value.name,
                    profilePic: value.profilePic
                });
            }
        });
        
        socket.emit('online-users', onlineUsers);
        
        socket.broadcast.emit('user-online', { 
            userId, 
            name, 
            profilePic: profilePic || null 
        });
        
        if (offlineMessages.has(userId)) {
            const messages = offlineMessages.get(userId);
            messages.forEach(msg => {
                socket.emit('private-message', {
                    fromUserId: msg.fromUserId,
                    fromName: msg.fromName,
                    message: msg.message,
                    timestamp: msg.timestamp,
                    isOfflineDelivery: true
                });
            });
            offlineMessages.delete(userId);
            console.log(`Delivered ${messages.length} offline messages to ${name}`);
        }
        
        console.log(`✅ User ${name} (${userId}) logged in from device ${deviceId}`);
    });

    // ========== Profile picture update ==========
    socket.on('update-profile', (data) => {
        const { userId, profilePic } = data;
        
        if (users.has(userId)) {
            const user = users.get(userId);
            user.profilePic = profilePic;
            users.set(userId, user);
            
            socket.broadcast.emit('profile-updated', {
                userId,
                profilePic
            });
        }
    });

    // ========== Private message with offline support ==========
    socket.on('private-message', (data) => {
        const { toUserId, message, fromUserId, fromName, messageId, timestamp, replyTo } = data;
        
        // Check if users are friends
        if (userFriends.has(fromUserId) && userFriends.get(fromUserId).has(toUserId)) {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('private-message', {
                    fromUserId,
                    fromName,
                    message,
                    timestamp,
                    messageId,
                    replyTo
                });
                
                console.log(`Message sent from ${fromName} to ${toUserId}`);
            } else {
                if (!offlineMessages.has(toUserId)) {
                    offlineMessages.set(toUserId, []);
                }
                
                offlineMessages.get(toUserId).push({
                    fromUserId,
                    fromName,
                    message,
                    timestamp,
                    messageId,
                    replyTo
                });
                
                console.log(`Message queued for offline user ${toUserId}`);
                
                socket.emit('message-queued', {
                    toUserId,
                    message
                });
            }
        } else {
            socket.emit('error', 'You can only message your friends. Send a friend request first!');
        }
    });

    // ========== Message reaction handler ==========
    socket.on('message-reaction', (data) => {
        const { messageId, toUserId, reaction, fromUserId, fromName, reactions } = data;
        
        console.log(`Reaction ${reaction} on message ${messageId} from ${fromName}`);
        
        if (users.has(toUserId)) {
            io.to(toUserId).emit('message-reaction', {
                messageId,
                fromUserId,
                fromName,
                reaction,
                reactions
            });
        }
        
        if (users.has(fromUserId)) {
            io.to(fromUserId).emit('message-reaction', {
                messageId,
                fromUserId,
                fromName,
                reaction,
                reactions
            });
        }
    });

    // ========== Voice message with offline support ==========
    socket.on('voice-message', (data) => {
        const { toUserId, audioUrl, fromUserId, fromName, duration, messageId, timestamp } = data;
        
        // Check if users are friends
        if (userFriends.has(fromUserId) && userFriends.get(fromUserId).has(toUserId)) {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('voice-message', {
                    fromUserId,
                    fromName,
                    audioUrl,
                    duration,
                    timestamp,
                    messageId
                });
            } else {
                if (!offlineMessages.has(toUserId)) {
                    offlineMessages.set(toUserId, []);
                }
                
                offlineMessages.get(toUserId).push({
                    fromUserId,
                    fromName,
                    type: 'voice',
                    audioUrl,
                    duration,
                    timestamp,
                    messageId
                });
            }
        } else {
            socket.emit('error', 'You can only send voice messages to your friends');
        }
    });

    // ========== File message with offline support ==========
    socket.on('file-message', (data) => {
        const { toUserId, fileUrl, fileName, fileType, fromUserId, fromName, messageId, timestamp } = data;
        
        // Check if users are friends
        if (userFriends.has(fromUserId) && userFriends.get(fromUserId).has(toUserId)) {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('file-message', {
                    fromUserId,
                    fromName,
                    fileUrl,
                    fileName,
                    fileType,
                    timestamp,
                    messageId
                });
            } else {
                if (!offlineMessages.has(toUserId)) {
                    offlineMessages.set(toUserId, []);
                }
                
                offlineMessages.get(toUserId).push({
                    fromUserId,
                    fromName,
                    type: 'file',
                    fileUrl,
                    fileName,
                    fileType,
                    timestamp,
                    messageId
                });
            }
        } else {
            socket.emit('error', 'You can only share files with your friends');
        }
    });

    // ========== Delete message handler ==========
    socket.on('delete-message', (data) => {
        const { messageId, toUserId, deleteType, fromUserId, timestamp } = data;
        
        if (deleteType === 'for-everyone') {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('message-deleted', {
                    messageId,
                    deleteType,
                    fromUserId,
                    timestamp
                });
            }
            
            io.to(fromUserId).emit('message-deleted', {
                messageId,
                deleteType,
                fromUserId,
                timestamp
            });
            
            console.log(`Message ${messageId} deleted for everyone`);
        } 
        else if (deleteType === 'for-me') {
            io.to(fromUserId).emit('message-deleted', {
                messageId,
                deleteType,
                fromUserId,
                timestamp
            });
            
            console.log(`Message ${messageId} deleted for user ${fromUserId}`);
        }
    });

    // ========== Message read receipt ==========
    socket.on('message-read', (data) => {
        const { messageId, fromUserId, toUserId } = data;
        io.to(fromUserId).emit('message-read', {
            messageId,
            fromUserId: toUserId
        });
    });

    // ========== All messages read ==========
    socket.on('messages-read', (data) => {
        const { toUserId, fromUserId } = data;
        io.to(toUserId).emit('messages-read', {
            fromUserId
        });
    });

    // ========== Typing indicator ==========
    socket.on('typing', (data) => {
        const { toUserId, fromUserId, isTyping } = data;
        
        // Only send typing indicator if friends
        if (userFriends.has(fromUserId) && userFriends.get(fromUserId).has(toUserId)) {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('typing-indicator', {
                    fromUserId,
                    isTyping
                });
            }
        }
    });

    // ========== Call signaling ==========
    socket.on('call-offer', (data) => {
        const { toUserId, offer, callType, fromUserId, fromName } = data;
        
        // Only allow calls between friends
        if (userFriends.has(fromUserId) && userFriends.get(fromUserId).has(toUserId)) {
            if (users.has(toUserId)) {
                io.to(toUserId).emit('call-offer', {
                    fromUserId,
                    fromName,
                    offer,
                    callType
                });
            }
        } else {
            socket.emit('error', 'You can only call your friends');
        }
    });

    socket.on('call-answer', (data) => {
        const { toUserId, answer, fromUserId } = data;
        io.to(toUserId).emit('call-answer', { 
            answer,
            fromUserId
        });
    });

    socket.on('ice-candidate', (data) => {
        const { toUserId, candidate, fromUserId } = data;
        io.to(toUserId).emit('ice-candidate', { 
            candidate,
            fromUserId
        });
    });

    socket.on('call-end', (data) => {
        const { toUserId, fromUserId } = data;
        io.to(toUserId).emit('call-end', { fromUserId });
    });

    socket.on('call-busy', (data) => {
        const { toUserId, fromUserId } = data;
        io.to(toUserId).emit('call-busy', { fromUserId });
    });

    // ========== Last seen update ==========
    socket.on('update-last-seen', (data) => {
        const { userId, timestamp } = data;
        socket.broadcast.emit('last-seen-update', {
            userId,
            timestamp
        });
    });

    // ========== FRIEND REQUEST FUNCTIONS ==========

    // Send friend request
    socket.on('send-friend-request', (data) => {
        const { fromUserId, fromName, toUserId } = data;
        
        if (fromUserId === toUserId) {
            socket.emit('error', 'Cannot send request to yourself');
            return;
        }
        
        // Check if already friends
        if (userFriends.has(fromUserId) && userFriends.get(fromUserId).has(toUserId)) {
            socket.emit('error', 'Already friends');
            return;
        }
        
        // Check if request already pending
        let existingRequest = null;
        friendRequests.forEach((request, requestId) => {
            if ((request.fromUserId === fromUserId && request.toUserId === toUserId) ||
                (request.fromUserId === toUserId && request.toUserId === fromUserId)) {
                existingRequest = request;
            }
        });
        
        if (existingRequest) {
            if (existingRequest.status === 'pending') {
                socket.emit('error', 'Friend request already pending');
            } else if (existingRequest.status === 'accepted') {
                socket.emit('error', 'Already friends');
            }
            return;
        }
        
        const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        
        const request = {
            requestId,
            fromUserId,
            fromName,
            toUserId,
            status: 'pending',
            timestamp: new Date().toISOString()
        };
        
        friendRequests.set(requestId, request);
        
        // Add to pending requests sets
        if (!userPendingRequests.has(toUserId)) {
            userPendingRequests.set(toUserId, new Set());
        }
        userPendingRequests.get(toUserId).add(requestId);
        
        if (!userPendingRequests.has(fromUserId)) {
            userPendingRequests.set(fromUserId, new Set());
        }
        userPendingRequests.get(fromUserId).add(requestId);
        
        console.log(`📨 Friend request sent from ${fromName} (${fromUserId}) to ${toUserId}`);
        
        // Notify recipient
        if (users.has(toUserId)) {
            io.to(toUserId).emit('new-friend-request', {
                requestId,
                fromUserId,
                fromName,
                timestamp: request.timestamp
            });
        }
        
        // Notify sender
        socket.emit('friend-request-sent', {
            requestId,
            toUserId,
            toName: users.get(toUserId)?.name || 'Unknown',
            timestamp: request.timestamp
        });
    });

    // Accept friend request
    socket.on('accept-friend-request', (data) => {
        const { requestId, userId } = data;
        
        if (!friendRequests.has(requestId)) {
            socket.emit('error', 'Friend request not found');
            return;
        }
        
        const request = friendRequests.get(requestId);
        
        if (request.toUserId !== userId) {
            socket.emit('error', 'Unauthorized');
            return;
        }
        
        if (request.status !== 'pending') {
            socket.emit('error', 'Request already processed');
            return;
        }
        
        // Update request status
        request.status = 'accepted';
        friendRequests.set(requestId, request);
        
        // Add to friends lists
        if (!userFriends.has(request.fromUserId)) {
            userFriends.set(request.fromUserId, new Set());
        }
        userFriends.get(request.fromUserId).add(request.toUserId);
        
        if (!userFriends.has(request.toUserId)) {
            userFriends.set(request.toUserId, new Set());
        }
        userFriends.get(request.toUserId).add(request.fromUserId);
        
        console.log(`✅ Friend request accepted: ${request.fromUserId} and ${request.toUserId} are now friends`);
        
        // Get user details
        const fromUser = users.get(request.fromUserId);
        const toUser = users.get(request.toUserId);
        
        // Notify both users
        [request.fromUserId, request.toUserId].forEach(uid => {
            if (users.has(uid)) {
                io.to(uid).emit('friend-request-accepted', {
                    requestId,
                    friendId: uid === request.fromUserId ? request.toUserId : request.fromUserId,
                    friendName: uid === request.fromUserId ? toUser?.name : fromUser?.name,
                    friendProfilePic: uid === request.fromUserId ? toUser?.profilePic : fromUser?.profilePic
                });
            }
        });
    });

    // Reject friend request
    socket.on('reject-friend-request', (data) => {
        const { requestId, userId } = data;
        
        if (!friendRequests.has(requestId)) {
            socket.emit('error', 'Friend request not found');
            return;
        }
        
        const request = friendRequests.get(requestId);
        
        if (request.toUserId !== userId) {
            socket.emit('error', 'Unauthorized');
            return;
        }
        
        if (request.status !== 'pending') {
            socket.emit('error', 'Request already processed');
            return;
        }
        
        // Update request status
        request.status = 'rejected';
        friendRequests.set(requestId, request);
        
        console.log(`❌ Friend request rejected: ${request.fromUserId} -> ${request.toUserId}`);
        
        // Notify requester
        if (users.has(request.fromUserId)) {
            io.to(request.fromUserId).emit('friend-request-rejected', {
                requestId,
                byUserId: request.toUserId
            });
        }
        
        socket.emit('friend-request-rejected', { requestId });
    });

    // Cancel friend request
    socket.on('cancel-friend-request', (data) => {
        const { requestId, userId } = data;
        
        if (!friendRequests.has(requestId)) {
            socket.emit('error', 'Friend request not found');
            return;
        }
        
        const request = friendRequests.get(requestId);
        
        if (request.fromUserId !== userId) {
            socket.emit('error', 'Unauthorized');
            return;
        }
        
        if (request.status !== 'pending') {
            socket.emit('error', 'Cannot cancel processed request');
            return;
        }
        
        // Remove request
        friendRequests.delete(requestId);
        
        // Remove from pending sets
        if (userPendingRequests.has(request.fromUserId)) {
            userPendingRequests.get(request.fromUserId).delete(requestId);
        }
        if (userPendingRequests.has(request.toUserId)) {
            userPendingRequests.get(request.toUserId).delete(requestId);
        }
        
        console.log(`✖️ Friend request cancelled: ${request.fromUserId} -> ${request.toUserId}`);
        
        // Notify recipient
        if (users.has(request.toUserId)) {
            io.to(request.toUserId).emit('friend-request-cancelled', {
                requestId,
                byUserId: request.fromUserId
            });
        }
        
        socket.emit('friend-request-cancelled', { requestId });
    });

    // Get user's friends
    socket.on('get-my-friends', (data) => {
        const { userId } = data;
        
        const friends = [];
        
        if (userFriends.has(userId)) {
            userFriends.get(userId).forEach(friendId => {
                const friend = users.get(friendId);
                if (friend) {
                    friends.push({
                        userId: friendId,
                        name: friend.name,
                        profilePic: friend.profilePic,
                        online: users.has(friendId) // Check if online
                    });
                }
            });
        }
        
        socket.emit('my-friends', friends);
    });

    // Get pending friend requests
    socket.on('get-pending-requests', (data) => {
        const { userId } = data;
        
        const pendingRequests = [];
        
        if (userPendingRequests.has(userId)) {
            userPendingRequests.get(userId).forEach(requestId => {
                const request = friendRequests.get(requestId);
                if (request && request.status === 'pending') {
                    if (request.toUserId === userId) {
                        // Incoming request
                        const fromUser = users.get(request.fromUserId);
                        pendingRequests.push({
                            requestId,
                            type: 'incoming',
                            fromUserId: request.fromUserId,
                            fromName: fromUser?.name || request.fromName,
                            fromProfilePic: fromUser?.profilePic,
                            timestamp: request.timestamp
                        });
                    } else if (request.fromUserId === userId) {
                        // Outgoing request
                        const toUser = users.get(request.toUserId);
                        pendingRequests.push({
                            requestId,
                            type: 'outgoing',
                            toUserId: request.toUserId,
                            toName: toUser?.name || 'Unknown',
                            toProfilePic: toUser?.profilePic,
                            timestamp: request.timestamp
                        });
                    }
                }
            });
        }
        
        socket.emit('pending-requests', pendingRequests);
    });

    // Search users to add as friend
    socket.on('search-users-to-add', (data) => {
        const { query, userId } = data;
        
        const results = [];
        
        users.forEach((user, uid) => {
            if (uid === userId) return; // Skip self
            
            // Check if already friends
            const isFriend = userFriends.has(userId) && userFriends.get(userId).has(uid);
            
            // Check if request pending
            let requestPending = false;
            let requestId = null;
            let requestType = null;
            
            if (userPendingRequests.has(userId)) {
                userPendingRequests.get(userId).forEach(reqId => {
                    const req = friendRequests.get(reqId);
                    if (req && req.status === 'pending') {
                        if ((req.fromUserId === userId && req.toUserId === uid) ||
                            (req.fromUserId === uid && req.toUserId === userId)) {
                            requestPending = true;
                            requestId = reqId;
                            requestType = req.fromUserId === userId ? 'outgoing' : 'incoming';
                        }
                    }
                });
            }
            
            if (user.name.toLowerCase().includes(query.toLowerCase()) || 
                uid.toLowerCase().includes(query.toLowerCase())) {
                results.push({
                    userId: uid,
                    name: user.name,
                    profilePic: user.profilePic,
                    isFriend,
                    requestPending,
                    requestId,
                    requestType,
                    online: users.has(uid)
                });
            }
        });
        
        socket.emit('users-search-results', results);
    });

    // Unfriend
    socket.on('unfriend', (data) => {
        const { userId, friendId } = data;
        
        if (!userFriends.has(userId) || !userFriends.get(userId).has(friendId)) {
            socket.emit('error', 'Not friends');
            return;
        }
        
        // Remove from both friends lists
        userFriends.get(userId).delete(friendId);
        userFriends.get(friendId).delete(userId);
        
        // Find and delete any friend requests between them
        friendRequests.forEach((request, requestId) => {
            if ((request.fromUserId === userId && request.toUserId === friendId) ||
                (request.fromUserId === friendId && request.toUserId === userId)) {
                friendRequests.delete(requestId);
            }
        });
        
        console.log(`💔 Unfriended: ${userId} and ${friendId}`);
        
        // Notify both users
        [userId, friendId].forEach(uid => {
            if (users.has(uid)) {
                io.to(uid).emit('unfriended', {
                    userId: uid === userId ? friendId : userId
                });
            }
        });
    });

    // ========== GROUP CHAT FUNCTIONS ==========

    // Create new group
    socket.on('create-group', (data) => {
        const { name, description, members, type, createdBy, icon } = data;
        
        const groupId = 'group_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        
        // Created by is automatically admin
        const admins = [createdBy];
        
        const group = {
            groupId,
            name,
            description: description || '',
            icon: icon || null,
            createdBy,
            createdAt: new Date().toISOString(),
            members: [createdBy, ...members],
            admins: admins,
            type: type || 'private',
            settings: {
                allowMembersToAdd: type === 'public',
                onlyAdminsCanMessage: false,
                hideLastSeen: false
            }
        };
        
        groups.set(groupId, group);
        groupMessages.set(groupId, []);
        
        // Notify all members
        group.members.forEach(memberId => {
            if (users.has(memberId)) {
                io.to(memberId).emit('group-created', {
                    groupId,
                    name,
                    description,
                    icon,
                    createdBy,
                    createdAt: group.createdAt,
                    members: group.members,
                    admins: group.admins,
                    type: group.type,
                    settings: group.settings
                });
            }
        });
        
        socket.emit('group-created-success', { groupId, name });
        console.log(`Group "${name}" created by ${createdBy} with ${group.members.length} members`);
    });

    // Get user's groups
    socket.on('get-my-groups', (data) => {
        const { userId } = data;
        const myGroups = [];
        
        groups.forEach((group, groupId) => {
            if (group.members.includes(userId)) {
                const isAdmin = group.admins.includes(userId);
                myGroups.push({
                    groupId,
                    name: group.name,
                    icon: group.icon,
                    members: group.members.length,
                    isAdmin: isAdmin,
                    lastMessage: groupMessages.get(groupId)?.slice(-1)[0] || null,
                    unread: 0 // You can implement unread count later
                });
            }
        });
        
        socket.emit('my-groups', myGroups);
    });

    // Get group messages
    socket.on('get-group-messages', (data) => {
        const { groupId, userId } = data;
        
        if (!groups.has(groupId)) {
            socket.emit('error', 'Group not found');
            return;
        }
        
        const group = groups.get(groupId);
        if (!group.members.includes(userId)) {
            socket.emit('error', 'You are not a member of this group');
            return;
        }
        
        const messages = groupMessages.get(groupId) || [];
        
        // Add admin info to messages for UI
        const messagesWithAdminInfo = messages.map(msg => ({
            ...msg,
            isSenderAdmin: group.admins.includes(msg.fromUserId)
        }));
        
        socket.emit('group-messages', { groupId, messages: messagesWithAdminInfo });
    });

    // Send group message
    socket.on('group-message', (data) => {
        const { groupId, message, fromUserId, fromName, messageId, timestamp, replyTo } = data;
        
        if (!groups.has(groupId)) return;
        
        const group = groups.get(groupId);
        if (!group.members.includes(fromUserId)) return;
        
        // Check if only admins can message
        if (group.settings.onlyAdminsCanMessage && !group.admins.includes(fromUserId)) {
            socket.emit('error', 'Only admins can send messages in this group');
            return;
        }
        
        const isSenderAdmin = group.admins.includes(fromUserId);
        
        const messageData = {
            messageId,
            fromUserId,
            fromName,
            message,
            timestamp,
            replyTo: replyTo || null,
            reactions: [],
            isSenderAdmin
        };
        
        // Store message
        const messages = groupMessages.get(groupId) || [];
        messages.push(messageData);
        groupMessages.set(groupId, messages);
        
        // Broadcast to all group members
        group.members.forEach(memberId => {
            if (users.has(memberId)) {
                io.to(memberId).emit('group-message', {
                    groupId,
                    ...messageData
                });
            }
        });
    });

    // Group message reaction
    socket.on('group-message-reaction', (data) => {
        const { groupId, messageId, reaction, fromUserId, fromName, reactions } = data;
        
        if (!groups.has(groupId)) return;
        
        const group = groups.get(groupId);
        if (!group.members.includes(fromUserId)) return;
        
        // Update message reactions in storage
        const messages = groupMessages.get(groupId) || [];
        const msgIndex = messages.findIndex(m => m.messageId === messageId);
        if (msgIndex !== -1) {
            messages[msgIndex].reactions = reactions;
            groupMessages.set(groupId, messages);
        }
        
        // Broadcast to all group members
        group.members.forEach(memberId => {
            if (users.has(memberId)) {
                io.to(memberId).emit('group-message-reaction', {
                    groupId,
                    messageId,
                    fromUserId,
                    fromName,
                    reaction,
                    reactions
                });
            }
        });
    });

    // Make member admin
    socket.on('make-group-admin', (data) => {
        const { groupId, memberId, madeBy } = data;
        
        if (!groups.has(groupId)) {
            socket.emit('error', 'Group not found');
            return;
        }
        
        const group = groups.get(groupId);
        
        if (!group.admins.includes(madeBy)) {
            socket.emit('error', 'Only admins can make other admins');
            return;
        }
        
        if (!group.members.includes(memberId)) {
            socket.emit('error', 'User is not a member of this group');
            return;
        }
        
        if (group.admins.includes(memberId)) {
            socket.emit('error', 'User is already an admin');
            return;
        }
        
        group.admins.push(memberId);
        groups.set(groupId, group);
        
        const memberName = users.get(memberId)?.name || 'Unknown';
        const madeByName = users.get(madeBy)?.name || 'Unknown';
        
        console.log(`✅ ${madeByName} made ${memberName} admin in group ${group.name}`);
        
        group.members.forEach(mId => {
            if (users.has(mId)) {
                io.to(mId).emit('group-admin-made', {
                    groupId,
                    groupName: group.name,
                    memberId,
                    memberName,
                    madeBy,
                    madeByName,
                    admins: group.admins,
                    message: `${memberName} is now an admin`
                });
            }
        });
        
        socket.emit('group-admin-made-success', {
            groupId,
            memberId,
            memberName
        });
    });

    // Remove admin
    socket.on('remove-group-admin', (data) => {
        const { groupId, memberId, removedBy } = data;
        
        if (!groups.has(groupId)) {
            socket.emit('error', 'Group not found');
            return;
        }
        
        const group = groups.get(groupId);
        
        if (!group.admins.includes(removedBy)) {
            socket.emit('error', 'Only admins can remove admins');
            return;
        }
        
        if (memberId === group.createdBy) {
            socket.emit('error', 'Cannot remove creator from admins');
            return;
        }
        
        if (!group.admins.includes(memberId)) {
            socket.emit('error', 'User is not an admin');
            return;
        }
        
        const index = group.admins.indexOf(memberId);
        if (index !== -1) {
            group.admins.splice(index, 1);
            groups.set(groupId, group);
            
            const memberName = users.get(memberId)?.name || 'Unknown';
            const removedByName = users.get(removedBy)?.name || 'Unknown';
            
            console.log(`❌ ${removedByName} removed ${memberName} from admins in group ${group.name}`);
            
            group.members.forEach(mId => {
                if (users.has(mId)) {
                    io.to(mId).emit('group-admin-removed', {
                        groupId,
                        groupName: group.name,
                        memberId,
                        memberName,
                        removedBy,
                        removedByName,
                        admins: group.admins,
                        message: `${memberName} is no longer an admin`
                    });
                }
            });
        }
    });

    // Transfer group ownership
    socket.on('transfer-group-ownership', (data) => {
        const { groupId, newOwnerId, currentOwnerId } = data;
        
        if (!groups.has(groupId)) {
            socket.emit('error', 'Group not found');
            return;
        }
        
        const group = groups.get(groupId);
        
        if (group.createdBy !== currentOwnerId) {
            socket.emit('error', 'Only group creator can transfer ownership');
            return;
        }
        
        if (!group.members.includes(newOwnerId)) {
            socket.emit('error', 'New owner must be a group member');
            return;
        }
        
        group.createdBy = newOwnerId;
        
        if (!group.admins.includes(newOwnerId)) {
            group.admins.push(newOwnerId);
        }
        
        groups.set(groupId, group);
        
        const oldOwnerName = users.get(currentOwnerId)?.name || 'Unknown';
        const newOwnerName = users.get(newOwnerId)?.name || 'Unknown';
        
        console.log(`👑 Group ${group.name} ownership transferred from ${oldOwnerName} to ${newOwnerName}`);
        
        group.members.forEach(mId => {
            if (users.has(mId)) {
                io.to(mId).emit('group-ownership-transferred', {
                    groupId,
                    groupName: group.name,
                    oldOwnerId: currentOwnerId,
                    oldOwnerName,
                    newOwnerId,
                    newOwnerName,
                    admins: group.admins,
                    message: `${newOwnerName} is now the group owner`
                });
            }
        });
    });

    // Add member to group (admin only)
    socket.on('add-group-member', (data) => {
        const { groupId, memberId, addedBy } = data;
        
        if (!groups.has(groupId)) return;
        
        const group = groups.get(groupId);
        
        if (!group.admins.includes(addedBy)) {
            socket.emit('error', 'Only admins can add members');
            return;
        }
        
        if (group.members.includes(memberId)) {
            socket.emit('error', 'User is already a member');
            return;
        }
        
        group.members.push(memberId);
        groups.set(groupId, group);
        
        const addedByName = users.get(addedBy)?.name || 'Unknown';
        const memberName = users.get(memberId)?.name || 'Unknown';
        
        console.log(`➕ ${addedByName} added ${memberName} to group ${group.name}`);
        
        group.members.forEach(mId => {
            if (users.has(mId)) {
                io.to(mId).emit('group-member-added', {
                    groupId,
                    groupName: group.name,
                    memberId,
                    memberName,
                    addedBy,
                    addedByName,
                    members: group.members,
                    message: `${memberName} joined the group`
                });
            }
        });
    });

    // Remove member from group (admin only)
    socket.on('remove-group-member', (data) => {
        const { groupId, memberId, removedBy } = data;
        
        if (!groups.has(groupId)) return;
        
        const group = groups.get(groupId);
        
        if (memberId === group.createdBy) {
            socket.emit('error', 'Cannot remove group creator');
            return;
        }
        
        if (!group.admins.includes(removedBy) && removedBy !== memberId) {
            socket.emit('error', 'Only admins can remove members');
            return;
        }
        
        const memberIndex = group.members.indexOf(memberId);
        if (memberIndex !== -1) {
            group.members.splice(memberIndex, 1);
            
            const adminIndex = group.admins.indexOf(memberId);
            if (adminIndex !== -1) {
                group.admins.splice(adminIndex, 1);
            }
            
            groups.set(groupId, group);
            
            const removedByName = users.get(removedBy)?.name || 'Unknown';
            const memberName = users.get(memberId)?.name || 'Unknown';
            
            console.log(`➖ ${removedByName} removed ${memberName} from group ${group.name}`);
            
            group.members.forEach(mId => {
                if (users.has(mId)) {
                    io.to(mId).emit('group-member-removed', {
                        groupId,
                        groupName: group.name,
                        memberId,
                        memberName,
                        removedBy,
                        removedByName,
                        members: group.members,
                        message: `${memberName} was removed from the group`
                    });
                }
            });
            
            if (users.has(memberId)) {
                io.to(memberId).emit('removed-from-group', {
                    groupId,
                    groupName: group.name,
                    removedBy,
                    removedByName,
                    message: `You were removed from ${group.name}`
                });
            }
        }
    });

    // Update group settings (admin only)
    socket.on('update-group-settings', (data) => {
        const { groupId, settings, updatedBy } = data;
        
        if (!groups.has(groupId)) return;
        
        const group = groups.get(groupId);
        
        if (!group.admins.includes(updatedBy)) {
            socket.emit('error', 'Only admins can update group settings');
            return;
        }
        
        group.settings = { ...group.settings, ...settings };
        groups.set(groupId, group);
        
        const updatedByName = users.get(updatedBy)?.name || 'Unknown';
        
        console.log(`⚙️ ${updatedByName} updated settings for group ${group.name}`);
        
        group.members.forEach(mId => {
            if (users.has(mId)) {
                io.to(mId).emit('group-settings-updated', {
                    groupId,
                    groupName: group.name,
                    settings: group.settings,
                    updatedBy,
                    updatedByName,
                    message: 'Group settings were updated'
                });
            }
        });
    });

    // Get group info with admin details
    socket.on('get-group-info', (data) => {
        const { groupId, userId } = data;
        
        if (!groups.has(groupId)) {
            socket.emit('error', 'Group not found');
            return;
        }
        
        const group = groups.get(groupId);
        
        if (!group.members.includes(userId)) {
            socket.emit('error', 'You are not a member of this group');
            return;
        }
        
        const membersWithDetails = group.members.map(memberId => {
            const user = users.get(memberId);
            return {
                userId: memberId,
                name: user?.name || 'Unknown',
                profilePic: user?.profilePic || null,
                isAdmin: group.admins.includes(memberId),
                isCreator: memberId === group.createdBy
            };
        });
        
        const messageCount = groupMessages.get(groupId)?.length || 0;
        
        socket.emit('group-info', {
            groupId,
            name: group.name,
            description: group.description,
            icon: group.icon,
            createdBy: group.createdBy,
            createdByName: users.get(group.createdBy)?.name || 'Unknown',
            createdAt: group.createdAt,
            type: group.type,
            settings: group.settings,
            members: membersWithDetails,
            admins: group.admins,
            totalMembers: group.members.length,
            totalMessages: messageCount,
            isCurrentUserAdmin: group.admins.includes(userId),
            isCurrentUserCreator: userId === group.createdBy
        });
    });

    // Leave group
    socket.on('leave-group', (data) => {
        const { groupId, userId } = data;
        
        if (!groups.has(groupId)) return;
        
        const group = groups.get(groupId);
        
        if (userId === group.createdBy) {
            socket.emit('error', 'Group creator cannot leave. Transfer ownership first or delete group.');
            return;
        }
        
        const index = group.members.indexOf(userId);
        if (index !== -1) {
            group.members.splice(index, 1);
            
            const adminIndex = group.admins.indexOf(userId);
            if (adminIndex !== -1) {
                group.admins.splice(adminIndex, 1);
            }
            
            groups.set(groupId, group);
            
            const userName = users.get(userId)?.name || 'Unknown';
            
            console.log(`👋 ${userName} left group ${group.name}`);
            
            group.members.forEach(mId => {
                if (users.has(mId)) {
                    io.to(mId).emit('group-member-left', {
                        groupId,
                        groupName: group.name,
                        userId,
                        userName,
                        members: group.members,
                        message: `${userName} left the group`
                    });
                }
            });
            
            socket.emit('left-group', { groupId, groupName: group.name });
        }
    });

    // Delete group (creator only)
    socket.on('delete-group', (data) => {
        const { groupId, userId } = data;
        
        if (!groups.has(groupId)) return;
        
        const group = groups.get(groupId);
        
        if (group.createdBy !== userId) {
            socket.emit('error', 'Only group creator can delete group');
            return;
        }
        
        const groupName = group.name;
        const deletedByName = users.get(userId)?.name || 'Unknown';
        
        console.log(`🗑️ ${deletedByName} deleted group ${groupName}`);
        
        group.members.forEach(memberId => {
            if (users.has(memberId)) {
                io.to(memberId).emit('group-deleted', {
                    groupId,
                    groupName,
                    deletedBy: userId,
                    deletedByName,
                    message: `Group "${groupName}" was deleted`
                });
            }
        });
        
        groups.delete(groupId);
        groupMessages.delete(groupId);
    });

    // ========== Handle disconnection ==========
    socket.on('disconnect', () => {
        let disconnectedUser = null;
        let disconnectedUserId = null;
        
        users.forEach((value, key) => {
            if (value.socketId === socket.id) {
                disconnectedUser = value;
                disconnectedUserId = key;
            }
        });
        
        if (disconnectedUser) {
            users.delete(disconnectedUserId);
            userNames.delete(disconnectedUser.name);
            
            socket.broadcast.emit('user-offline', {
                userId: disconnectedUserId,
                name: disconnectedUser.name
            });
            
            console.log(`User ${disconnectedUser.name} disconnected`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ HJH Chat app running on https://testing-chat-production.up.railway.app`);
});

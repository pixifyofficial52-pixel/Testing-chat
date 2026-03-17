const socket = io({
    secure: true,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    transports: ['websocket', 'polling']
});

let currentUser = null;
let selectedUser = null;
let typingTimeout = null;
let blockedUsers = [];
let allUsers = [];
let unreadMessages = new Map();
let messageQueue = new Map();
let searchActive = false;

// Voice recording
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimer = null;

// Call variables
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callActive = false;
let pendingCall = null;
let callType = null;
let callStartTime = null;
let callTimer = null;

// Delete feature variables
let selectedMessageForDelete = null;
let deleteMenuTimeout = null;

// Reply feature variables
let replyToMessage = null;

// Reactions variables
let activeReactionPicker = null;

// ========== GROUP CHAT VARIABLES ==========
let currentGroup = null;
let myGroups = new Map(); // groupId -> group data
let selectedMembers = new Set();
let currentGroupInfo = null;

// ========== FRIEND REQUEST VARIABLES ==========
let friends = new Map(); // friendId -> friend data
let pendingRequests = []; // {requestId, type, from/to details}

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

// ========== Toast Notifications ==========
function showToast(message, type = 'error') {
    const existingToast = document.querySelector('.custom-toast');
    if (existingToast) existingToast.remove();
    
    const toast = document.createElement('div');
    toast.className = `custom-toast ${type}`;
    
    let icon = 'fa-circle-exclamation';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'warning') icon = 'fa-triangle-exclamation';
    if (type === 'info') icon = 'fa-circle-info';
    
    toast.innerHTML = `<i class="fas ${icon}"></i><span>${message}</span>`;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ========== Get Device Info ==========
async function getDeviceInfo() {
    try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        const ip = ipData.ip;
        
        const userAgent = navigator.userAgent;
        const screenRes = `${screen.width}x${screen.height}x${screen.colorDepth}`;
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const language = navigator.language;
        const platform = navigator.platform;
        const hardwareConcurrency = navigator.hardwareConcurrency || 'unknown';
        const deviceMemory = navigator.deviceMemory || 'unknown';
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        
        const fingerprint = `${ip}-${userAgent}-${screenRes}-${timeZone}-${language}-${platform}-${hardwareConcurrency}-${deviceMemory}-${timestamp}-${random}`;
        const deviceId = btoa(unescape(encodeURIComponent(fingerprint))).substring(0, 25).replace(/[^a-zA-Z0-9]/g, '');
        
        return { ip, deviceId, userAgent, platform, timestamp };
    } catch (error) {
        const randomStr = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
        const deviceId = `dev_${randomStr.substring(0, 20)}`;
        return { ip: 'unknown', deviceId, userAgent: navigator.userAgent, platform: navigator.platform, timestamp: Date.now() };
    }
}

// ========== Generate User ID ==========
async function generateUniqueUserId() {
    let permanentUserId = localStorage.getItem('hj-permanent-user-id');
    if (permanentUserId) return permanentUserId;
    
    let deviceId = localStorage.getItem('hj-device-id');
    if (!deviceId) {
        const deviceInfo = await getDeviceInfo();
        deviceId = deviceInfo.deviceId;
        localStorage.setItem('hj-device-id', deviceId);
        localStorage.setItem('hj-device-ip', deviceInfo.ip);
        localStorage.setItem('hj-device-platform', deviceInfo.platform);
    }
    
    const installationId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem('hj-installation-id', installationId);
    
    const permanentId = `usr_${deviceId}_${installationId.substring(0, 8)}`;
    localStorage.setItem('hj-permanent-user-id', permanentId);
    localStorage.setItem('hj-device-installation', installationId);
    
    return permanentId;
}

// ========== Load/Save User Data ==========
function loadUserData() {
    const saved = localStorage.getItem('hj-user-data');
    return saved ? JSON.parse(saved) : null;
}

function saveUserData(userData) {
    localStorage.setItem('hj-user-data', JSON.stringify(userData));
}

// ========== Chat History ==========
function loadChatHistory(userId) {
    if (!currentUser) return [];
    const history = localStorage.getItem(`chat_${currentUser.userId}_${userId}`);
    return history ? JSON.parse(history) : [];
}

function saveMessageToHistory(toUserId, messageData) {
    if (!currentUser) return;
    const key = `chat_${currentUser.userId}_${toUserId}`;
    const history = loadChatHistory(toUserId);
    history.push(messageData);
    localStorage.setItem(key, JSON.stringify(history));
    return messageData.messageId;
}

function updateMessageInHistory(toUserId, messageId, updates) {
    if (!currentUser) return;
    const key = `chat_${currentUser.userId}_${toUserId}`;
    const history = loadChatHistory(toUserId);
    const index = history.findIndex(msg => msg.messageId === messageId);
    if (index !== -1) {
        history[index] = { ...history[index], ...updates };
        localStorage.setItem(key, JSON.stringify(history));
    }
}

function loadMessagesWithUser(userId) {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    
    const history = loadChatHistory(userId);
    history.forEach(msg => {
        if (msg.type === 'voice') {
            displayVoiceMessage({ ...msg, fromName: msg.fromName });
        } else if (msg.type === 'file') {
            displayFileMessage({ ...msg, fromName: msg.fromName });
        } else {
            displayMessage(msg.fromName, msg.message, msg.fromName === 'You' ? 'sent' : 'received', msg.timestamp, msg.messageId, msg);
        }
    });
}

// ========== Profile Picture ==========
function uploadProfilePicture() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            const data = await res.json();
            
            currentUser.profilePic = data.fileUrl;
            saveUserData(currentUser);
            
            const profilePicDiv = document.getElementById('profile-pic');
            profilePicDiv.innerHTML = `<img src="${data.fileUrl}" alt="Profile">`;
            
            updateUserProfilePic(currentUser.userId, data.fileUrl);
            socket.emit('update-profile', { userId: currentUser.userId, profilePic: data.fileUrl });
            
        } catch (error) {
            showToast('Failed to upload profile picture', 'error');
        }
    };
    input.click();
}

function updateUserProfilePic(userId, profilePic) {
    const userItem = document.getElementById(`user-${userId}`);
    if (userItem) {
        const avatar = userItem.querySelector('.user-avatar');
        if (avatar) avatar.innerHTML = `<img src="${profilePic}" alt="Profile">`;
    }
}

// ========== Block/Unblock ==========
function blockUser(userId, userName) {
    if (!blockedUsers.includes(userId)) {
        blockedUsers.push(userId);
        localStorage.setItem('hj-blocked-users', JSON.stringify(blockedUsers));
        showToast(`${userName} has been blocked`, 'success');
        updateBlockButton(userId, true);
    }
}

function unblockUser(userId, userName) {
    const index = blockedUsers.indexOf(userId);
    if (index > -1) {
        blockedUsers.splice(index, 1);
        localStorage.setItem('hj-blocked-users', JSON.stringify(blockedUsers));
        showToast(`${userName} has been unblocked`, 'success');
        updateBlockButton(userId, false);
    }
}

function updateBlockButton(userId, isBlocked) {
    const userItem = document.getElementById(`user-${userId}`);
    if (!userItem) return;
    
    const existingBtn = userItem.querySelector('.block-btn');
    if (existingBtn) existingBtn.remove();
    
    const blockBtn = document.createElement('button');
    blockBtn.className = 'block-btn';
    blockBtn.innerHTML = isBlocked ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-ban"></i>';
    blockBtn.title = isBlocked ? 'Unblock' : 'Block';
    blockBtn.onclick = (e) => {
        e.stopPropagation();
        if (isBlocked) {
            unblockUser(userId, userItem.querySelector('h4').textContent);
        } else {
            blockUser(userId, userItem.querySelector('h4').textContent);
        }
    };
    userItem.appendChild(blockBtn);
}

// ========== Global Search ==========
function toggleGlobalSearch() {
    const searchBar = document.getElementById('global-search-bar');
    if (searchBar) {
        searchBar.remove();
        searchActive = false;
    } else {
        showGlobalSearchBar();
    }
}

function showGlobalSearchBar() {
    const existingBar = document.getElementById('global-search-bar');
    if (existingBar) existingBar.remove();
    
    const searchBar = document.createElement('div');
    searchBar.id = 'global-search-bar';
    searchBar.className = 'global-search-bar';
    searchBar.innerHTML = `
        <div class="search-header">
            <h4><i class="fas fa-globe"></i> Search Users</h4>
            <button onclick="toggleGlobalSearch()" class="close-search"><i class="fas fa-times"></i></button>
        </div>
        <div class="search-input-wrapper">
            <i class="fas fa-search"></i>
            <input type="text" id="global-search-input" placeholder="Search by name or user ID..." autofocus>
        </div>
        <div id="search-results" class="search-results">
            <div class="search-hint">Type at least 2 characters to search</div>
        </div>
    `;
    
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.prepend(searchBar);
        searchActive = true;
        
        const input = document.getElementById('global-search-input');
        if (input) {
            input.addEventListener('input', debounce(performGlobalSearch, 300));
            input.focus();
        }
        socket.emit('get-all-users');
    }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function performGlobalSearch() {
    const input = document.getElementById('global-search-input');
    if (!input) return;
    
    const query = input.value.trim().toLowerCase();
    const resultsDiv = document.getElementById('search-results');
    if (!resultsDiv) return;
    
    if (query.length < 2) {
        resultsDiv.innerHTML = '<div class="search-hint">Type at least 2 characters to search</div>';
        return;
    }
    
    resultsDiv.innerHTML = '<div class="search-loading"><i class="fas fa-spinner fa-spin"></i> Searching...</div>';
    
    if (allUsers.length > 0) {
        const filtered = allUsers.filter(user => 
            user.userId !== currentUser?.userId &&
            (user.name.toLowerCase().includes(query) || user.userId.toLowerCase().includes(query))
        );
        displaySearchResults(filtered);
    }
    
    socket.emit('search-users', { query, currentUserId: currentUser?.userId });
}

function displaySearchResults(users) {
    const resultsDiv = document.getElementById('search-results');
    if (!resultsDiv) return;
    
    if (!users || users.length === 0) {
        resultsDiv.innerHTML = '<div class="no-results">No users found</div>';
        return;
    }
    
    let html = '';
    users.forEach(user => {
        if (user.userId === currentUser?.userId) return;
        
        const isOnline = isUserOnline(user.userId);
        const statusClass = isOnline ? 'online' : 'offline';
        const statusText = isOnline ? 'Online' : 'Offline';
        const hasUnread = unreadMessages.has(user.userId);
        
        html += `
            <div class="search-result-item" onclick="startChatWithUser('${user.userId}', '${user.name}')">
                <div class="result-avatar">
                    ${user.profilePic ? `<img src="${user.profilePic}" alt="Profile">` : '<i class="fas fa-user-circle"></i>'}
                </div>
                <div class="result-info">
                    <div class="result-name">
                        ${user.name}
                        ${hasUnread ? '<span class="unread-badge-small">●</span>' : ''}
                    </div>
                    <div class="result-id">${user.userId}</div>
                </div>
                <div class="result-status ${statusClass}">
                    <i class="fas fa-circle"></i> ${statusText}
                </div>
            </div>
        `;
    });
    
    resultsDiv.innerHTML = html;
}

function startChatWithUser(userId, userName) {
    if (!document.getElementById(`user-${userId}`)) {
        addUserToList({ userId, name: userName, profilePic: null, online: isUserOnline(userId) });
    }
    selectUser({ userId, name: userName, profilePic: null });
    toggleGlobalSearch();
    showToast(`Chat started with ${userName}`, 'success');
}

// ========== Offline Message Queue ==========
function queueOfflineMessage(toUserId, messageData) {
    if (!messageQueue.has(toUserId)) messageQueue.set(toUserId, []);
    messageQueue.get(toUserId).push(messageData);
    saveMessageQueue();
}

function saveMessageQueue() {
    const queueObj = {};
    messageQueue.forEach((messages, userId) => queueObj[userId] = messages);
    localStorage.setItem('hj-message-queue', JSON.stringify(queueObj));
}

function loadMessageQueue() {
    const saved = localStorage.getItem('hj-message-queue');
    if (saved) {
        try {
            const queueObj = JSON.parse(saved);
            Object.keys(queueObj).forEach(userId => messageQueue.set(userId, queueObj[userId]));
        } catch (e) {}
    }
}

function deliverQueuedMessages(userId) {
    if (messageQueue.has(userId)) {
        const messages = messageQueue.get(userId);
        messages.forEach(msgData => {
            socket.emit('private-message', {
                toUserId: userId,
                message: msgData.message,
                fromUserId: currentUser.userId,
                fromName: currentUser.name,
                isOfflineMessage: true
            });
            saveMessageToHistory(userId, { fromName: 'You', message: msgData.message, timestamp: msgData.timestamp });
        });
        messageQueue.delete(userId);
        saveMessageQueue();
        showToast(`Messages delivered to ${userId}`, 'success');
    }
}

// ========== Push Notifications ==========
async function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    if (Notification.permission !== 'denied') await Notification.requestPermission();
}

function showNotification(title, options = {}) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (options.userId && selectedUser?.userId === options.userId) return;
    
    new Notification(title, {
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [200, 100, 200],
        ...options
    });
    playNotificationSound();
}

function playNotificationSound() {
    const audio = new Audio('data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADYABvb3R0aEUgAACTQAAgQwAAUULgAABqeXBoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQZAAD8A8AACAAAAAsAAABpAACAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQZAAD8A8AACAAAAAsAAABpAACAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    audio.play().catch(() => {});
}

// ========== Last Seen ==========
function updateLastSeen(userId) {
    const now = new Date();
    socket.emit('update-last-seen', { userId, timestamp: now.toISOString() });
}

function getLastSeenText(timestamp) {
    if (!timestamp) return 'Offline';
    const lastSeen = new Date(timestamp);
    const now = new Date();
    const diffMins = Math.floor((now - lastSeen) / 60000);
    if (diffMins < 1) return 'Online';
    if (diffMins < 60) return `Last seen ${diffMins} min ago`;
    if (diffMins < 1440) return `Last seen ${Math.floor(diffMins/60)} hour ago`;
    if (diffMins < 2880) return 'Last seen yesterday';
    return `Last seen ${Math.floor(diffMins/1440)} days ago`;
}

// ========== Message Search ==========
let messageSearchResults = [];
let currentMessageSearchIndex = -1;

function toggleMessageSearch() {
    const searchBar = document.getElementById('message-search-bar');
    if (searchBar) {
        searchBar.remove();
    } else {
        showMessageSearchBar();
    }
}

function showMessageSearchBar() {
    const searchBar = document.createElement('div');
    searchBar.id = 'message-search-bar';
    searchBar.className = 'message-search-bar';
    searchBar.innerHTML = `
        <div class="search-input-container">
            <i class="fas fa-search"></i>
            <input type="text" id="message-search-input" placeholder="Search in conversation..." autofocus>
            <span class="search-count" id="message-search-count"></span>
            <button onclick="toggleMessageSearch()" class="search-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="search-nav">
            <button onclick="searchPrevious()" id="search-prev" disabled><i class="fas fa-chevron-up"></i></button>
            <button onclick="searchNext()" id="search-next" disabled><i class="fas fa-chevron-down"></i></button>
        </div>
    `;
    
    document.querySelector('.chat-header').after(searchBar);
    
    document.getElementById('message-search-input').addEventListener('input', performMessageSearch);
}

function performMessageSearch() {
    const query = document.getElementById('message-search-input').value.toLowerCase().trim();
    if (!query || !selectedUser) {
        resetMessageSearch();
        return;
    }
    
    const messages = document.querySelectorAll('.message');
    messageSearchResults = [];
    
    messages.forEach((msg, index) => {
        if (msg.innerText.toLowerCase().includes(query)) {
            messageSearchResults.push(index);
            msg.classList.add('search-highlight');
        } else {
            msg.classList.remove('search-highlight');
        }
    });
    
    updateMessageSearchNavigation();
}

function updateMessageSearchNavigation() {
    const countSpan = document.getElementById('message-search-count');
    const prevBtn = document.getElementById('search-prev');
    const nextBtn = document.getElementById('search-next');
    
    if (messageSearchResults.length === 0) {
        countSpan.textContent = 'No results';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        currentMessageSearchIndex = -1;
    } else {
        currentMessageSearchIndex = 0;
        countSpan.textContent = `1/${messageSearchResults.length}`;
        prevBtn.disabled = true;
        nextBtn.disabled = messageSearchResults.length <= 1;
        scrollToMessageSearchResult(0);
    }
}

function searchNext() {
    if (messageSearchResults.length === 0) return;
    if (currentMessageSearchIndex < messageSearchResults.length - 1) {
        currentMessageSearchIndex++;
        updateMessageSearchNavButtons();
        scrollToMessageSearchResult(currentMessageSearchIndex);
    }
}

function searchPrevious() {
    if (messageSearchResults.length === 0) return;
    if (currentMessageSearchIndex > 0) {
        currentMessageSearchIndex--;
        updateMessageSearchNavButtons();
        scrollToMessageSearchResult(currentMessageSearchIndex);
    }
}

function updateMessageSearchNavButtons() {
    const countSpan = document.getElementById('message-search-count');
    const prevBtn = document.getElementById('search-prev');
    const nextBtn = document.getElementById('search-next');
    
    countSpan.textContent = `${currentMessageSearchIndex + 1}/${messageSearchResults.length}`;
    prevBtn.disabled = currentMessageSearchIndex <= 0;
    nextBtn.disabled = currentMessageSearchIndex >= messageSearchResults.length - 1;
}

function scrollToMessageSearchResult(index) {
    const messages = document.querySelectorAll('.message');
    messages[messageSearchResults[index]].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetMessageSearch() {
    messageSearchResults = [];
    currentMessageSearchIndex = -1;
    document.querySelectorAll('.message').forEach(msg => msg.classList.remove('search-highlight'));
    const countSpan = document.getElementById('message-search-count');
    if (countSpan) countSpan.textContent = '';
}

// ========== READ RECEIPTS (Blue Ticks) ==========
function markMessageAsRead(messageId, fromUserId) {
    if (!selectedUser || !currentUser) return;
    
    const messageEl = document.getElementById(`msg-${messageId}`);
    if (messageEl) {
        const timeEl = messageEl.querySelector('.time');
        if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
            timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
        }
    }
    
    updateMessageInHistory(fromUserId, messageId, { read: true, readAt: new Date().toISOString() });
    
    socket.emit('message-read', {
        messageId: messageId,
        fromUserId: fromUserId,
        toUserId: currentUser.userId
    });
}

function markAllMessagesAsRead(fromUserId) {
    if (!selectedUser || !currentUser) return;
    
    const messages = document.querySelectorAll('.message.received');
    messages.forEach(msg => {
        const timeEl = msg.querySelector('.time');
        if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
            timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
        }
    });
    
    socket.emit('messages-read', {
        toUserId: fromUserId,
        fromUserId: currentUser.userId
    });
}

// ========== Call Functions ==========
function startVideoCall() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    startCall('video');
}

function startVoiceCall() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    startCall('voice');
}

async function startCall(type) {
    try {
        if (callActive) {
            showToast('Call already in progress', 'warning');
            return;
        }
        
        if (!selectedUser) {
            showToast('Select a contact first', 'info');
            return;
        }
        
        if (!isUserOnline(selectedUser.userId)) {
            showToast('User is offline', 'warning');
            return;
        }
        
        // Check if friends
        if (!friends.has(selectedUser.userId)) {
            showToast('You can only call your friends', 'warning');
            return;
        }
        
        callType = type;
        
        const constraints = { 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 2,
                sampleRate: 48000
            }
        };
        
        if (type === 'video') {
            constraints.video = {
                width: { ideal: 640, min: 320 },
                height: { ideal: 480, min: 240 },
                facingMode: 'user',
                frameRate: { ideal: 20, min: 10 }
            };
        }
        
        showToast(`Requesting ${type === 'video' ? 'camera' : 'microphone'} access...`, 'info');
        
        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Local stream obtained:', localStream.getTracks().length, 'tracks');
        } catch (err) {
            console.error('Media device error:', err);
            let errorMessage = 'Failed to access media devices';
            if (err.name === 'NotAllowedError') {
                errorMessage = `${type === 'video' ? 'Camera' : 'Microphone'} access denied. Please allow permissions.`;
            } else if (err.name === 'NotFoundError') {
                errorMessage = `${type === 'video' ? 'Camera' : 'Microphone'} not found.`;
            } else if (err.name === 'NotReadableError') {
                errorMessage = `${type === 'video' ? 'Camera' : 'Microphone'} is already in use by another app.`;
            }
            showToast(errorMessage, 'error');
            return;
        }
        
        showCallDialog(`Calling ${selectedUser.name}...`, 'outgoing');
        
        peerConnection = new RTCPeerConnection({
            iceServers: configuration.iceServers,
            iceCandidatePoolSize: 10,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        localStream.getTracks().forEach(track => {
            console.log('Adding track:', track.kind, track.enabled);
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            console.log('Received remote track:', event.track.kind);
            if (!remoteStream) {
                remoteStream = new MediaStream();
            }
            remoteStream.addTrack(event.track);
            
            if (remoteStream.getTracks().length > 0) {
                showCallScreen(type);
                
                setTimeout(() => {
                    if (type === 'video') {
                        const remoteVideo = document.getElementById('remote-video');
                        if (remoteVideo) {
                            remoteVideo.srcObject = remoteStream;
                            remoteVideo.play().catch(e => console.log('Remote video play error:', e));
                        }
                    } else {
                        const audio = new Audio();
                        audio.srcObject = remoteStream;
                        audio.play().catch(e => console.log('Audio play error:', e));
                    }
                }, 500);
            }
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate');
                socket.emit('ice-candidate', { 
                    toUserId: selectedUser.userId, 
                    candidate: event.candidate,
                    fromUserId: currentUser.userId
                });
            }
        };
        
        peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                document.getElementById('call-dialog')?.remove();
                callStartTime = Date.now();
                startCallTimer();
            } else if (peerConnection.connectionState === 'disconnected' || 
                       peerConnection.connectionState === 'failed' ||
                       peerConnection.connectionState === 'closed') {
                showToast('Call disconnected', 'warning');
                endCall();
            }
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', peerConnection.iceConnectionState);
        };
        
        peerConnection.onsignalingstatechange = () => {
            console.log('Signaling state:', peerConnection.signalingState);
        };
        
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: type === 'video'
        });
        
        await peerConnection.setLocalDescription(offer);
        console.log('Offer created, waiting for answer');
        
        socket.emit('call-offer', { 
            toUserId: selectedUser.userId, 
            offer: offer,
            callType: type,
            fromUserId: currentUser.userId,
            fromName: currentUser.name
        });
        
        callActive = true;
        
    } catch (error) {
        console.error('Call error:', error);
        showToast('Failed to start call: ' + error.message, 'error');
        endCall();
    }
}

function showCallDialog(message, type) {
    const existingDialog = document.getElementById('call-dialog');
    if (existingDialog) existingDialog.remove();
    
    const dialog = document.createElement('div');
    dialog.className = 'call-dialog';
    dialog.id = 'call-dialog';
    dialog.innerHTML = `
        <div class="call-dialog-content">
            <div class="call-spinner"></div>
            <p>${message}</p>
            <button onclick="endCall()" class="end-call-btn"><i class="fas fa-phone-slash"></i> End</button>
        </div>
    `;
    document.body.appendChild(dialog);
}

function showCallScreen(type) {
    document.getElementById('call-dialog')?.remove();
    
    const existingScreen = document.getElementById('call-screen');
    if (existingScreen) existingScreen.remove();
    
    const callScreen = document.createElement('div');
    callScreen.className = 'call-screen';
    callScreen.id = 'call-screen';
    
    if (type === 'video') {
        callScreen.innerHTML = `
            <div class="call-container video">
                <div class="remote-video-container">
                    <video id="remote-video" autoplay playsinline></video>
                    <div class="call-info">
                        <h3>${selectedUser?.name || 'User'}</h3>
                        <p class="call-timer" id="call-timer">00:00</p>
                    </div>
                </div>
                <div class="local-video-container">
                    <video id="local-video" autoplay playsinline muted></video>
                </div>
                <div class="call-controls">
                    <button onclick="toggleMute()" id="mute-btn" class="call-control-btn"><i class="fas fa-microphone"></i></button>
                    <button onclick="toggleVideo()" id="video-btn" class="call-control-btn"><i class="fas fa-video"></i></button>
                    <button onclick="endCall()" class="call-control-btn end-call"><i class="fas fa-phone-slash"></i></button>
                </div>
            </div>
        `;
    } else {
        callScreen.innerHTML = `
            <div class="call-container audio">
                <div class="audio-call-container">
                    <div class="call-avatar">
                        ${selectedUser?.profilePic ? 
                            `<img src="${selectedUser.profilePic}" alt="Profile">` : 
                            '<i class="fas fa-user-circle"></i>'}
                    </div>
                    <h2>${selectedUser?.name || 'User'}</h2>
                    <p class="call-timer" id="call-timer">00:00</p>
                </div>
                <div class="call-controls">
                    <button onclick="toggleMute()" id="mute-btn" class="call-control-btn"><i class="fas fa-microphone"></i></button>
                    <button onclick="endCall()" class="call-control-btn end-call"><i class="fas fa-phone-slash"></i></button>
                </div>
            </div>
        `;
    }
    
    document.body.appendChild(callScreen);
    
    if (type === 'video') {
        setTimeout(() => {
            const localVideo = document.getElementById('local-video');
            if (localVideo && localStream) {
                localVideo.srcObject = localStream;
                localVideo.play().catch(e => console.log('Local video play error:', e));
            }
        }, 100);
    }
}

function startCallTimer() {
    if (callTimer) clearInterval(callTimer);
    
    callTimer = setInterval(() => {
        if (!callStartTime) return;
        
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timerStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        const timerEl = document.getElementById('call-timer');
        if (timerEl) timerEl.textContent = timerStr;
    }, 1000);
}

function endCall() {
    console.log('Ending call');
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log('Stopped track:', track.kind);
        });
        localStream = null;
    }
    
    remoteStream = null;
    
    document.getElementById('call-dialog')?.remove();
    document.getElementById('call-screen')?.remove();
    
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
    
    if (selectedUser && currentUser) {
        socket.emit('call-end', { 
            toUserId: selectedUser.userId, 
            fromUserId: currentUser.userId 
        });
    }
    
    callActive = false;
    callStartTime = null;
    callType = null;
}

function toggleMute() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            const btn = document.getElementById('mute-btn');
            if (btn) {
                btn.innerHTML = audioTrack.enabled ? 
                    '<i class="fas fa-microphone"></i>' : 
                    '<i class="fas fa-microphone-slash"></i>';
                btn.classList.toggle('muted', !audioTrack.enabled);
            }
            showToast(audioTrack.enabled ? 'Microphone unmuted' : 'Microphone muted', 'info');
        }
    }
}

function toggleVideo() {
    if (localStream && callType === 'video') {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            const btn = document.getElementById('video-btn');
            if (btn) {
                btn.innerHTML = videoTrack.enabled ? 
                    '<i class="fas fa-video"></i>' : 
                    '<i class="fas fa-video-slash"></i>';
                btn.classList.toggle('video-off', !videoTrack.enabled);
            }
            showToast(videoTrack.enabled ? 'Camera turned on' : 'Camera turned off', 'info');
        }
    }
}

// ========== Add user to list with online/offline separation ==========
function addUserToList(user) {
    const onlineList = document.getElementById('online-users-list');
    const offlineList = document.getElementById('offline-users-list');
    
    if (!onlineList || !offlineList) return;
    
    if (currentUser && user.userId === currentUser.userId) return;
    
    if (document.getElementById(`user-${user.userId}`)) return;
    
    const isOnline = user.online || false;
    const history = currentUser ? loadChatHistory(user.userId) : [];
    const unread = history.filter(msg => msg.fromName !== 'You').length;
    const isBlocked = blockedUsers.includes(user.userId);
    
    const userDiv = document.createElement('div');
    userDiv.className = 'user-item';
    userDiv.id = `user-${user.userId}`;
    userDiv.onclick = () => selectUser(user);
    
    const statusColor = isOnline ? '#4caf50' : '#f44336';
    const statusText = isOnline ? 'Online' : 'Offline';
    
    userDiv.innerHTML = `
        <div class="user-avatar" id="avatar-${user.userId}">
            ${user.profilePic ? `<img src="${user.profilePic}" alt="Profile">` : '<i class="fas fa-user-circle"></i>'}
        </div>
        <div class="user-info">
            <h4>${user.name} ${unread > 0 ? `<span class="unread-badge" style="background:#ff4444;color:white;padding:2px 6px;border-radius:10px;font-size:10px;margin-left:5px;">${unread}</span>` : ''}</h4>
            <p><i class="fas fa-circle" style="color:${statusColor};"></i> ${statusText}</p>
        </div>
    `;
    
    if (isOnline) {
        onlineList.appendChild(userDiv);
    } else {
        offlineList.appendChild(userDiv);
    }
    
    updateBlockButton(user.userId, isBlocked);
}

// ========== Update online/offline status ==========
function updateUserStatus(userId, isOnline) {
    const userDiv = document.getElementById(`user-${userId}`);
    if (!userDiv) return;
    
    const onlineList = document.getElementById('online-users-list');
    const offlineList = document.getElementById('offline-users-list');
    
    const statusEl = userDiv.querySelector('.user-info p');
    const statusColor = isOnline ? '#4caf50' : '#f44336';
    const statusText = isOnline ? 'Online' : 'Offline';
    
    statusEl.innerHTML = `<i class="fas fa-circle" style="color:${statusColor};"></i> ${statusText}`;
    
    if (isOnline) {
        if (offlineList.contains(userDiv)) {
            offlineList.removeChild(userDiv);
            onlineList.appendChild(userDiv);
        }
    } else {
        if (onlineList.contains(userDiv)) {
            onlineList.removeChild(userDiv);
            offlineList.appendChild(userDiv);
        }
    }
}

function removeUserFromList(userId) {
    const userDiv = document.getElementById(`user-${userId}`);
    if (userDiv) userDiv.remove();
}

function isUserOnline(userId) {
    const userDiv = document.getElementById(`user-${userId}`);
    if (!userDiv) return false;
    const statusEl = userDiv.querySelector('.user-info p');
    return statusEl.innerHTML.includes('color:#4caf50');
}

// ========== Login ==========
let pendingLogin = false;

function login() {
    if (pendingLogin) return;
    
    const name = document.getElementById('login-name').value.trim();
    const id = document.getElementById('login-userid').value.trim();
    
    if (!name || !id) { showToast('Please enter both name and ID', 'warning'); return; }
    
    pendingLogin = true;
    socket.emit('check-username', { name, userId: id, deviceId: localStorage.getItem('hj-device-id') || 'unknown' });
}

function completeLogin() {
    const name = document.getElementById('login-name').value.trim();
    const id = document.getElementById('login-userid').value.trim();
    
    currentUser = { userId: id, name, profilePic: loadUserData()?.profilePic || null };
    saveUserData(currentUser);
    localStorage.setItem('hj-device-user-id', id);
    
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('chat-screen').classList.add('active');
    document.getElementById('current-user-name').textContent = name;
    document.getElementById('current-user-id').textContent = id;
    
    socket.emit('user-login', currentUser);
    pendingLogin = false;
    
    updateChatHeader();
    loadMyGroups();
    loadFriendsData(); // Load friend data
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        localStorage.removeItem('hj-user-data');
        localStorage.removeItem('hj-device-user-id');
        
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('chat-screen').classList.remove('active');
        document.getElementById('login-name').value = '';
        document.getElementById('profile-pic').innerHTML = '<i class="fas fa-camera"></i>';
        document.getElementById('messages-container').innerHTML = '';
        document.getElementById('group-messages-container').innerHTML = '';
        selectedUser = null;
        currentGroup = null;
        currentUser = null;
        document.getElementById('no-chat-selected').classList.remove('hidden');
        document.getElementById('chat-with-name').textContent = 'Select Contact';
    }
}

// ========== Sidebar ==========
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('active');
}

// ========== Select user ==========
function selectUser(user) {
    // Check if friends
    if (!canChatWithUser(user.userId)) {
        showToast('You need to be friends to chat. Send a friend request first!', 'warning');
        
        // Switch to friends panel
        showFriendsPanel();
        
        // Auto-fill search with user name
        document.getElementById('find-users-search').value = user.name;
        searchUsersToAdd();
        return;
    }
    
    selectedUser = user;
    currentGroup = null;
    
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.group-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`user-${user.userId}`)?.classList.add('active');
    
    document.getElementById('chat-with-name').textContent = user.name;
    document.getElementById('chat-with-status').innerHTML = '<i class="fas fa-circle" style="color:#4caf50;"></i> Online';
    document.getElementById('no-chat-selected').classList.add('hidden');
    
    loadMessagesWithUser(user.userId);
    
    setTimeout(() => {
        markAllMessagesAsRead(user.userId);
    }, 500);
    
    if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('active');
    
    setTimeout(() => document.getElementById('message-input').focus(), 300);
}

// ========== Display message with delete feature and read receipts ==========
function displayMessage(senderName, message, type, timestamp, messageId, messageData = {}) {
    const container = document.getElementById('messages-container');
    
    if (document.getElementById(`msg-${messageId}`)) return;
    
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.id = `msg-${messageId}`;
    
    let timeString = '';
    if (timestamp) {
        const date = new Date(timestamp);
        timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    if (messageData.deletedForEveryone) {
        div.innerHTML = `
            ${type === 'received' ? `<div class="sender">${senderName}</div>` : ''}
            <div class="deleted-message">
                <i class="fas fa-trash"></i> This message was deleted
            </div>
            <div class="time">${timeString}</div>
        `;
        div.classList.add('deleted');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return;
    }
    
    if (messageData.deletedFor && messageData.deletedFor.includes(currentUser?.userId)) {
        return;
    }
    
    const readReceipt = (type === 'sent' && messageData.read) ? 
        ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>' : '';
    
    let replyHtml = '';
    if (messageData.replyTo) {
        const replySender = messageData.replyTo.senderName;
        const replyMessage = messageData.replyTo.message;
        replyHtml = `
            <div class="replied-message">
                <div class="replied-sender">${replySender}</div>
                <div class="replied-content">${replyMessage}</div>
            </div>
        `;
    }
    
    const deleteButton = type === 'sent' ? `
        <button class="message-delete-btn" onclick="showDeleteMenu('${messageId}', event)">
            <i class="fas fa-ellipsis-v"></i>
        </button>
    ` : '';
    
    const reactionButton = `
        <button class="message-reaction-btn" onclick="showReactionPicker('${messageId}', event)">
            <i class="far fa-smile"></i>
        </button>
    `;
    
    const replyButton = `
        <button class="message-reaction-btn" onclick="replyToMessage('${messageId}')" title="Reply">
            <i class="fas fa-reply"></i>
        </button>
    `;
    
    div.innerHTML = `
        ${type === 'received' ? `<div class="sender">${senderName}</div>` : ''}
        ${replyHtml}
        <div class="message-content">${message}</div>
        <div class="message-footer">
            <span class="time">${timeString}${readReceipt}</span>
            <div style="display: flex; gap: 2px;">
                ${replyButton}
                ${reactionButton}
                ${deleteButton}
            </div>
        </div>
    `;
    
    container.appendChild(div);
    
    if (messageData.reactions) {
        updateMessageReactions(messageId, messageData.reactions);
    }
    
    container.scrollTop = container.scrollHeight;
    
    if (type === 'received' && selectedUser && selectedUser.userId === messageData.fromUserId) {
        setTimeout(() => {
            markMessageAsRead(messageId, messageData.fromUserId);
        }, 1000);
    }
}

// ========== Send message ==========
function sendMessage() {
    if (!selectedUser) {
        showToast('Select a contact first', 'info');
        return;
    }
    
    if (!canChatWithUser(selectedUser.userId)) {
        showToast('You need to be friends to send messages!', 'warning');
        showFriendsPanel();
        return;
    }
    
    if (blockedUsers.includes(selectedUser.userId)) {
        showToast('You have blocked this user. Unblock to send messages.', 'warning');
        return;
    }
    
    const input = document.getElementById('message-input');
    const msg = input.value.trim();
    
    if (!msg) return;
    
    const messageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const timestamp = new Date().toISOString();
    
    const messageData = { 
        fromName: 'You', 
        message: msg, 
        timestamp: timestamp,
        messageId: messageId,
        deletedFor: [],
        deletedForEveryone: false,
        read: false,
        delivered: false,
        reactions: []
    };
    
    if (replyToMessage) {
        messageData.replyTo = {
            messageId: replyToMessage.messageId,
            senderName: replyToMessage.senderName,
            message: replyToMessage.message,
            type: replyToMessage.type
        };
        cancelReply();
    }
    
    displayMessage('You', msg, 'sent', timestamp, messageId, messageData);
    saveMessageToHistory(selectedUser.userId, messageData);
    
    if (isUserOnline(selectedUser.userId)) {
        socket.emit('private-message', { 
            toUserId: selectedUser.userId, 
            message: msg, 
            fromUserId: currentUser.userId, 
            fromName: currentUser.name,
            messageId: messageId,
            timestamp: timestamp,
            replyTo: messageData.replyTo
        });
    } else {
        queueOfflineMessage(selectedUser.userId, { 
            message: msg, 
            timestamp: timestamp,
            messageId: messageId,
            replyTo: messageData.replyTo
        });
        showToast('User is offline. Message will be delivered when they come online.', 'info');
    }
    
    input.value = '';
    input.focus();
}

// ========== Delete Message Functions ==========
function showDeleteMenu(messageId, event) {
    event.stopPropagation();
    
    closeDeleteMenu();
    
    selectedMessageForDelete = messageId;
    
    const messageElement = document.getElementById(`msg-${messageId}`);
    if (!messageElement) return;
    
    const menu = document.createElement('div');
    menu.className = 'delete-menu';
    menu.id = `delete-menu-${messageId}`;
    
    const history = selectedUser ? loadChatHistory(selectedUser.userId) : [];
    const messageData = history.find(msg => msg.messageId === messageId);
    
    const canDeleteForEveryone = messageData && canDeleteMessage(messageData.timestamp);
    
    menu.innerHTML = `
        <div class="delete-menu-header">
            <i class="fas fa-trash"></i> Delete Message
        </div>
        <div class="delete-menu-options">
            <button onclick="deleteForMe('${messageId}')" class="delete-option">
                <i class="fas fa-user-slash"></i> Delete for me
            </button>
            ${canDeleteForEveryone ? `
                <button onclick="deleteForEveryone('${messageId}')" class="delete-option delete-for-all">
                    <i class="fas fa-users-slash"></i> Delete for everyone
                </button>
            ` : ''}
        </div>
    `;
    
    const rect = messageElement.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.top - 10}px`;
    menu.style.left = `${rect.right - 200}px`;
    
    document.body.appendChild(menu);
    
    deleteMenuTimeout = setTimeout(closeDeleteMenu, 5000);
}

function closeDeleteMenu() {
    const existingMenu = document.querySelector('.delete-menu');
    if (existingMenu) existingMenu.remove();
    if (deleteMenuTimeout) clearTimeout(deleteMenuTimeout);
    selectedMessageForDelete = null;
}

function canDeleteMessage(timestamp) {
    const messageTime = new Date(timestamp).getTime();
    const now = new Date().getTime();
    const diffMinutes = (now - messageTime) / (1000 * 60);
    return diffMinutes <= 5;
}

function deleteForMe(messageId) {
    if (!selectedUser || !currentUser) return;
    
    closeDeleteMenu();
    
    if (!confirm('Delete this message for you?')) return;
    
    const history = loadChatHistory(selectedUser.userId);
    const messageIndex = history.findIndex(msg => msg.messageId === messageId);
    
    if (messageIndex === -1) return;
    
    if (!history[messageIndex].deletedFor) {
        history[messageIndex].deletedFor = [];
    }
    
    if (!history[messageIndex].deletedFor.includes(currentUser.userId)) {
        history[messageIndex].deletedFor.push(currentUser.userId);
    }
    
    const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
    localStorage.setItem(key, JSON.stringify(history));
    
    const messageElement = document.getElementById(`msg-${messageId}`);
    if (messageElement) {
        messageElement.remove();
    }
    
    socket.emit('delete-message', {
        messageId: messageId,
        toUserId: selectedUser.userId,
        deleteType: 'for-me',
        fromUserId: currentUser.userId,
        timestamp: new Date().toISOString()
    });
    
    showToast('Message deleted', 'success');
}

function deleteForEveryone(messageId) {
    if (!selectedUser || !currentUser) return;
    
    closeDeleteMenu();
    
    if (!confirm('Delete this message for everyone? This cannot be undone!')) return;
    
    const history = loadChatHistory(selectedUser.userId);
    const messageIndex = history.findIndex(msg => msg.messageId === messageId);
    
    if (messageIndex === -1) return;
    
    if (!canDeleteMessage(history[messageIndex].timestamp)) {
        showToast('Cannot delete message after 5 minutes', 'warning');
        return;
    }
    
    history[messageIndex].deletedForEveryone = true;
    history[messageIndex].deletedAt = new Date().toISOString();
    
    const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
    localStorage.setItem(key, JSON.stringify(history));
    
    const messageElement = document.getElementById(`msg-${messageId}`);
    if (messageElement) {
        const timeElement = messageElement.querySelector('.time');
        const timeText = timeElement ? timeElement.textContent : '';
        
        messageElement.innerHTML = `
            <div class="deleted-message">
                <i class="fas fa-trash"></i> This message was deleted
            </div>
            <div class="time">${timeText}</div>
        `;
        messageElement.classList.add('deleted');
    }
    
    socket.emit('delete-message', {
        messageId: messageId,
        toUserId: selectedUser.userId,
        deleteType: 'for-everyone',
        fromUserId: currentUser.userId,
        timestamp: new Date().toISOString()
    });
    
    showToast('Message deleted for everyone', 'success');
}

// ========== Reply Functions ==========
function replyToMessage(messageId) {
    if (!selectedUser || !currentUser) return;
    
    const history = loadChatHistory(selectedUser.userId);
    const messageData = history.find(m => m.messageId === messageId);
    
    if (!messageData) return;
    
    replyToMessage = {
        messageId: messageId,
        senderName: messageData.fromName === 'You' ? 'You' : messageData.fromName,
        message: messageData.message || (messageData.type === 'file' ? '📎 File' : messageData.type === 'voice' ? '🎤 Voice' : ''),
        type: messageData.type || 'text'
    };
    
    const replyIndicator = document.getElementById('reply-indicator');
    const replySender = document.getElementById('reply-sender');
    const replyPreview = document.getElementById('reply-preview');
    
    replySender.textContent = replyToMessage.senderName;
    replyPreview.textContent = replyToMessage.message;
    replyIndicator.style.display = 'flex';
    
    document.getElementById('message-input').focus();
    
    const messageEl = document.getElementById(`msg-${messageId}`);
    if (messageEl) {
        messageEl.classList.add('replying');
    }
}

function cancelReply() {
    replyToMessage = null;
    
    document.getElementById('reply-indicator').style.display = 'none';
    
    document.querySelectorAll('.message.replying').forEach(msg => {
        msg.classList.remove('replying');
    });
}

// ========== Message Reactions ==========
function showReactionPicker(messageId, event) {
    event.stopPropagation();
    
    if (activeReactionPicker) {
        activeReactionPicker.remove();
        activeReactionPicker = null;
    }
    
    const messageEl = document.getElementById(`msg-${messageId}`);
    if (!messageEl) return;
    
    const rect = messageEl.getBoundingClientRect();
    
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.id = `reaction-picker-${messageId}`;
    picker.innerHTML = `
        <button onclick="addReaction('${messageId}', '👍')">👍</button>
        <button onclick="addReaction('${messageId}', '❤️')">❤️</button>
        <button onclick="addReaction('${messageId}', '😂')">😂</button>
        <button onclick="addReaction('${messageId}', '😮')">😮</button>
        <button onclick="addReaction('${messageId}', '😢')">😢</button>
        <button onclick="addReaction('${messageId}', '😡')">😡</button>
    `;
    
    picker.style.position = 'fixed';
    picker.style.top = `${rect.top - 50}px`;
    picker.style.right = `${window.innerWidth - rect.right + 10}px`;
    
    document.body.appendChild(picker);
    activeReactionPicker = picker;
    
    setTimeout(() => {
        if (activeReactionPicker) {
            activeReactionPicker.remove();
            activeReactionPicker = null;
        }
    }, 3000);
}

function addReaction(messageId, reaction) {
    if (!selectedUser || !currentUser) return;
    
    activeReactionPicker?.remove();
    activeReactionPicker = null;
    
    const history = loadChatHistory(selectedUser.userId);
    const msgIndex = history.findIndex(m => m.messageId === messageId);
    
    if (msgIndex === -1) return;
    
    if (!history[msgIndex].reactions) {
        history[msgIndex].reactions = [];
    }
    
    const existingIndex = history[msgIndex].reactions.findIndex(
        r => r.userId === currentUser.userId
    );
    
    if (existingIndex !== -1) {
        if (history[msgIndex].reactions[existingIndex].reaction === reaction) {
            history[msgIndex].reactions.splice(existingIndex, 1);
        } else {
            history[msgIndex].reactions[existingIndex].reaction = reaction;
            history[msgIndex].reactions[existingIndex].timestamp = new Date().toISOString();
        }
    } else {
        history[msgIndex].reactions.push({
            userId: currentUser.userId,
            userName: currentUser.name,
            reaction: reaction,
            timestamp: new Date().toISOString()
        });
    }
    
    const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
    localStorage.setItem(key, JSON.stringify(history));
    
    updateMessageReactions(messageId, history[msgIndex].reactions);
    
    socket.emit('message-reaction', {
        messageId: messageId,
        toUserId: selectedUser.userId,
        reaction: reaction,
        fromUserId: currentUser.userId,
        fromName: currentUser.name,
        reactions: history[msgIndex].reactions
    });
}

function updateMessageReactions(messageId, reactions) {
    const messageEl = document.getElementById(`msg-${messageId}`);
    if (!messageEl) return;
    
    const existingContainer = messageEl.querySelector('.message-reactions');
    if (existingContainer) existingContainer.remove();
    
    if (!reactions || reactions.length === 0) return;
    
    const reactionCounts = {};
    reactions.forEach(r => {
        reactionCounts[r.reaction] = (reactionCounts[r.reaction] || 0) + 1;
    });
    
    const reactionsDiv = document.createElement('div');
    reactionsDiv.className = 'message-reactions';
    
    Object.entries(reactionCounts).forEach(([reaction, count]) => {
        const isActive = reactions.some(r => 
            r.userId === currentUser?.userId && r.reaction === reaction
        );
        
        const btn = document.createElement('button');
        btn.className = `reaction-btn ${isActive ? 'active' : ''}`;
        btn.innerHTML = `${reaction} ${count}`;
        btn.onclick = (e) => {
            e.stopPropagation();
            addReaction(messageId, reaction);
        };
        
        reactionsDiv.appendChild(btn);
    });
    
    messageEl.appendChild(reactionsDiv);
}

// ========== Voice recording ==========
async function startVoiceRecording() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    if (blockedUsers.includes(selectedUser.userId)) { showToast('You have blocked this user. Unblock to send messages.', 'warning'); return; }
    
    // Check if friends
    if (!friends.has(selectedUser.userId)) {
        showToast('You can only send voice messages to your friends', 'warning');
        return;
    }
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        
        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
        mediaRecorder.onstop = () => stream.getTracks().forEach(t => t.stop());
        
        mediaRecorder.start();
        recordingStartTime = Date.now();
        
        document.getElementById('message-input-area').style.display = 'none';
        document.getElementById('voice-recording').classList.add('active');
        
        recordingTimer = setInterval(() => {
            const sec = Math.floor((Date.now() - recordingStartTime) / 1000);
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            document.getElementById('recording-time').textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }, 1000);
        
    } catch (err) {
        showToast('Microphone access denied', 'error');
    }
}

function cancelRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    clearInterval(recordingTimer);
    document.getElementById('voice-recording').classList.remove('active');
    document.getElementById('message-input-area').style.display = 'flex';
    document.getElementById('message-input').focus();
}

async function sendVoiceMessage() {
    if (!mediaRecorder || !selectedUser) return;
    
    mediaRecorder.stop();
    clearInterval(recordingTimer);
    
    mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
        
        const formData = new FormData();
        formData.append('file', blob, 'voice.webm');
        
        const res = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        
        const messageId = Date.now() + '-' + Math.random().toString(36).substring(2, 8);
        const messageData = { 
            fromName: 'You', 
            type: 'voice', 
            audioUrl: data.fileUrl, 
            duration, 
            timestamp: new Date().toISOString(),
            messageId: messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: false,
            reactions: []
        };
        
        displayVoiceMessage({ fromName: 'You', audioUrl: data.fileUrl, duration, timestamp: messageData.timestamp, messageId: messageId });
        saveMessageToHistory(selectedUser.userId, messageData);
        
        socket.emit('voice-message', { 
            toUserId: selectedUser.userId, 
            audioUrl: data.fileUrl, 
            duration, 
            fromUserId: currentUser.userId, 
            fromName: currentUser.name,
            messageId: messageId,
            timestamp: messageData.timestamp
        });
        
        document.getElementById('voice-recording').classList.remove('active');
        document.getElementById('message-input-area').style.display = 'flex';
        document.getElementById('message-input').focus();
    };
}

function displayVoiceMessage(data) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    const isSent = data.fromName === 'You';
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.id = `msg-${data.messageId}`;
    
    const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const m = Math.floor(data.duration / 60);
    const s = data.duration % 60;
    
    const readReceipt = (isSent && data.read) ? 
        ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>' : '';
    
    if (data.deletedForEveryone) {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="deleted-message">
                <i class="fas fa-trash"></i> Voice message deleted
            </div>
            <div class="time">${time}</div>
        `;
        div.classList.add('deleted');
    } else {
        const deleteButton = isSent ? `
            <button class="message-delete-btn" onclick="showDeleteMenu('${data.messageId}', event)">
                <i class="fas fa-ellipsis-v"></i>
            </button>
        ` : '';
        
        const reactionButton = `
            <button class="message-reaction-btn" onclick="showReactionPicker('${data.messageId}', event)">
                <i class="far fa-smile"></i>
            </button>
        `;
        
        const replyButton = `
            <button class="message-reaction-btn" onclick="replyToMessage('${data.messageId}')" title="Reply">
                <i class="fas fa-reply"></i>
            </button>
        `;
        
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="voice-message">
                <audio controls src="${data.audioUrl}"></audio>
                <span>${m}:${s.toString().padStart(2, '0')}</span>
            </div>
            <div class="message-footer">
                <span class="time">${time}${readReceipt}</span>
                <div style="display: flex; gap: 2px;">
                    ${replyButton}
                    ${reactionButton}
                    ${deleteButton}
                </div>
            </div>
        `;
    }
    
    container.appendChild(div);
    
    if (data.reactions) {
        updateMessageReactions(data.messageId, data.reactions);
    }
    
    container.scrollTop = container.scrollHeight;
    
    if (!isSent && selectedUser && selectedUser.userId === data.fromUserId) {
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
    }
}

// ========== File sharing ==========
function sendPhoto() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    if (blockedUsers.includes(selectedUser.userId)) { showToast('You have blocked this user. Unblock to send messages.', 'warning'); return; }
    
    // Check if friends
    if (!friends.has(selectedUser.userId)) {
        showToast('You can only share photos with your friends', 'warning');
        return;
    }
    
    const input = document.getElementById('file-input');
    input.accept = 'image/*';
    input.click();
}

function sendFile() {
    if (!selectedUser) { showToast('Select a contact first', 'info'); return; }
    if (blockedUsers.includes(selectedUser.userId)) { showToast('You have blocked this user. Unblock to send messages.', 'warning'); return; }
    
    // Check if friends
    if (!friends.has(selectedUser.userId)) {
        showToast('You can only share files with your friends', 'warning');
        return;
    }
    
    const input = document.getElementById('file-input');
    input.accept = '*/*';
    input.click();
}

async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file || !selectedUser) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    
    const messageId = Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const messageData = { 
        fromName: 'You', 
        type: 'file', 
        fileUrl: data.fileUrl, 
        fileName: data.fileName, 
        fileType: data.fileType, 
        timestamp: new Date().toISOString(),
        messageId: messageId,
        deletedFor: [],
        deletedForEveryone: false,
        read: false,
        delivered: false,
        reactions: []
    };
    
    displayFileMessage({ fromName: 'You', fileUrl: data.fileUrl, fileName: data.fileName, fileType: data.fileType, timestamp: messageData.timestamp, messageId: messageId });
    saveMessageToHistory(selectedUser.userId, messageData);
    
    socket.emit('file-message', { 
        toUserId: selectedUser.userId, 
        fileUrl: data.fileUrl, 
        fileName: data.fileName, 
        fileType: data.fileType, 
        fromUserId: currentUser.userId, 
        fromName: currentUser.name,
        messageId: messageId,
        timestamp: messageData.timestamp
    });
}

function displayFileMessage(data) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    const isSent = data.fromName === 'You';
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.id = `msg-${data.messageId}`;
    
    const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const readReceipt = (isSent && data.read) ? 
        ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>' : '';
    
    if (data.deletedForEveryone) {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="deleted-message">
                <i class="fas fa-trash"></i> File deleted
            </div>
            <div class="time">${time}</div>
        `;
        div.classList.add('deleted');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return;
    }
    
    let icon = 'fa-file';
    if (data.fileType.startsWith('image/')) icon = 'fa-image';
    else if (data.fileType.startsWith('audio/')) icon = 'fa-music';
    else if (data.fileType.startsWith('video/')) icon = 'fa-video';
    
    const deleteButton = isSent ? `
        <button class="message-delete-btn" onclick="showDeleteMenu('${data.messageId}', event)">
            <i class="fas fa-ellipsis-v"></i>
        </button>
    ` : '';
    
    const reactionButton = `
        <button class="message-reaction-btn" onclick="showReactionPicker('${data.messageId}', event)">
            <i class="far fa-smile"></i>
        </button>
    `;
    
    const replyButton = `
        <button class="message-reaction-btn" onclick="replyToMessage('${data.messageId}')" title="Reply">
            <i class="fas fa-reply"></i>
        </button>
    `;
    
    if (data.fileType.startsWith('image/')) {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <img src="${data.fileUrl}" class="image-message" onclick="window.open('${data.fileUrl}')">
            <div class="message-footer">
                <span class="time">${time}${readReceipt}</span>
                <div style="display: flex; gap: 2px;">
                    ${replyButton}
                    ${reactionButton}
                    ${deleteButton}
                </div>
            </div>
        `;
    } else {
        div.innerHTML = `
            ${!isSent ? `<div class="sender">${data.fromName}</div>` : ''}
            <div class="file-message">
                <i class="fas ${icon}"></i>
                <a href="${data.fileUrl}" target="_blank">${data.fileName}</a>
            </div>
            <div class="message-footer">
                <span class="time">${time}${readReceipt}</span>
                <div style="display: flex; gap: 2px;">
                    ${replyButton}
                    ${reactionButton}
                    ${deleteButton}
                </div>
            </div>
        `;
    }
    
    container.appendChild(div);
    
    if (data.reactions) {
        updateMessageReactions(data.messageId, data.reactions);
    }
    
    container.scrollTop = container.scrollHeight;
    
    if (!isSent && selectedUser && selectedUser.userId === data.fromUserId) {
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
    }
}

// ========== Typing indicator ==========
function handleKeyPress(e) {
    if (e.key === 'Enter') { 
        sendMessage(); 
        return; 
    }
    if (!selectedUser) return;
    
    // Only send typing indicator to friends
    if (friends.has(selectedUser.userId)) {
        socket.emit('typing', { toUserId: selectedUser.userId, fromUserId: currentUser.userId, isTyping: true });
        
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit('typing', { toUserId: selectedUser.userId, fromUserId: currentUser.userId, isTyping: false });
        }, 1000);
    }
}

// ========== Update chat header ==========
function updateChatHeader() {
    const actions = document.getElementById('chat-actions');
    if (!actions) return;
    
    actions.innerHTML = `
        <button class="action-btn" onclick="sendFile()" title="Send File"><i class="fas fa-paperclip"></i></button>
        <button class="action-btn" onclick="sendPhoto()" title="Send Photo"><i class="fas fa-camera"></i></button>
        <button class="action-btn video-call-btn" onclick="startVideoCall()" title="Video Call"><i class="fas fa-video"></i></button>
        <button class="action-btn voice-call-btn" onclick="startVoiceCall()" title="Voice Call"><i class="fas fa-phone"></i></button>
        <button class="action-btn search-global-btn" onclick="toggleGlobalSearch()" title="Search Users"><i class="fas fa-globe"></i></button>
        <button class="action-btn search-msg-btn" onclick="toggleMessageSearch()" title="Search in Chat"><i class="fas fa-search"></i></button>
    `;
}

// ========== Dark Mode Functions ==========
function initTheme() {
    const savedTheme = localStorage.getItem('hj-theme') || 'light';
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        const toggleBtn = document.getElementById('theme-toggle');
        if (toggleBtn) toggleBtn.innerHTML = '☀️';
    }
}

function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('hj-theme', isDark ? 'dark' : 'light');
    
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
        toggleBtn.innerHTML = isDark ? '☀️' : '🌙';
    }
    
    showToast(`${isDark ? 'Dark' : 'Light'} mode enabled`, 'success');
}

// ========== PANEL TOGGLE FUNCTIONS ==========
function showChatPanel() {
    document.getElementById('chats-panel').style.display = 'block';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('groups-panel').style.display = 'none';
    document.getElementById('chats-area').style.display = 'flex';
    document.getElementById('group-chat-area').style.display = 'none';
    
    document.getElementById('chats-toggle').classList.add('active');
    document.getElementById('friends-toggle').classList.remove('active');
    document.getElementById('groups-toggle').classList.remove('active');
    
    currentGroup = null;
}

function showFriendsPanel() {
    document.getElementById('chats-panel').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'block';
    document.getElementById('groups-panel').style.display = 'none';
    document.getElementById('chats-area').style.display = 'flex';
    document.getElementById('group-chat-area').style.display = 'none';
    
    document.getElementById('chats-toggle').classList.remove('active');
    document.getElementById('friends-toggle').classList.add('active');
    document.getElementById('groups-toggle').classList.remove('active');
    
    currentGroup = null;
    selectedUser = null;
    
    loadFriendsData();
}

function showGroupPanel() {
    document.getElementById('chats-panel').style.display = 'none';
    document.getElementById('friends-panel').style.display = 'none';
    document.getElementById('groups-panel').style.display = 'block';
    document.getElementById('chats-area').style.display = 'none';
    document.getElementById('group-chat-area').style.display = 'flex';
    
    document.getElementById('chats-toggle').classList.remove('active');
    document.getElementById('friends-toggle').classList.remove('active');
    document.getElementById('groups-toggle').classList.add('active');
    
    loadMyGroups();
}

// ========== FRIEND REQUEST FUNCTIONS ==========

function loadFriendsData() {
    loadMyFriends();
    loadPendingRequests();
}

function loadMyFriends() {
    socket.emit('get-my-friends', { userId: currentUser?.userId });
}

function loadPendingRequests() {
    socket.emit('get-pending-requests', { userId: currentUser?.userId });
}

function displayPendingRequests(requests) {
    const container = document.getElementById('pending-requests-list');
    pendingRequests = requests;
    
    // Update badge count
    const incomingCount = requests.filter(r => r.type === 'incoming').length;
    document.getElementById('pending-requests-count').textContent = incomingCount;
    
    if (requests.length === 0) {
        container.innerHTML = '<div class="no-data">No pending requests</div>';
        return;
    }
    
    container.innerHTML = '';
    
    requests.forEach(request => {
        const div = document.createElement('div');
        div.className = 'request-item';
        
        if (request.type === 'incoming') {
            // Incoming request (someone wants to be your friend)
            div.innerHTML = `
                <div class="request-avatar">
                    ${request.fromProfilePic ? `<img src="${request.fromProfilePic}">` : '<i class="fas fa-user"></i>'}
                </div>
                <div class="request-info">
                    <div class="request-name">${request.fromName}</div>
                    <div class="request-status">Wants to be your friend</div>
                </div>
                <div class="request-actions">
                    <button class="accept-btn" onclick="acceptFriendRequest('${request.requestId}')" title="Accept">
                        <i class="fas fa-check"></i>
                    </button>
                    <button class="reject-btn" onclick="rejectFriendRequest('${request.requestId}')" title="Reject">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
        } else {
            // Outgoing request (you sent request)
            div.innerHTML = `
                <div class="request-avatar">
                    ${request.toProfilePic ? `<img src="${request.toProfilePic}">` : '<i class="fas fa-user"></i>'}
                </div>
                <div class="request-info">
                    <div class="request-name">${request.toName}</div>
                    <div class="request-status">Request sent <span class="pending-badge">Pending</span></div>
                </div>
                <div class="request-actions">
                    <button class="cancel-btn" onclick="cancelFriendRequest('${request.requestId}')" title="Cancel">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
        }
        
        container.appendChild(div);
    });
}

function displayMyFriends(friendsList) {
    const container = document.getElementById('friends-list');
    friends.clear();
    
    if (friendsList.length === 0) {
        container.innerHTML = '<div class="no-data">No friends yet. Add some!</div>';
        return;
    }
    
    container.innerHTML = '';
    
    friendsList.forEach(friend => {
        friends.set(friend.userId, friend);
        
        const div = document.createElement('div');
        div.className = 'friend-item';
        div.onclick = () => startChatWithFriend(friend);
        
        const statusColor = friend.online ? '#4caf50' : '#f44336';
        const statusText = friend.online ? 'Online' : 'Offline';
        
        div.innerHTML = `
            <div class="friend-avatar">
                ${friend.profilePic ? `<img src="${friend.profilePic}">` : '<i class="fas fa-user"></i>'}
            </div>
            <div class="friend-info">
                <div class="friend-name">${friend.name}</div>
                <div class="friend-status">
                    <i class="fas fa-circle" style="color: ${statusColor}; font-size: 8px;"></i> ${statusText}
                </div>
            </div>
        `;
        
        container.appendChild(div);
    });
}

function displayUserSearchResults(users) {
    const container = document.getElementById('find-users-results');
    
    if (!users || users.length === 0) {
        container.innerHTML = '<div class="no-data">No users found</div>';
        return;
    }
    
    container.innerHTML = '';
    
    users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'user-search-item';
        
        let actionButton = '';
        let buttonDisabled = false;
        
        if (user.isFriend) {
            actionButton = `<button class="add-friend-btn" disabled><i class="fas fa-check"></i> Friends</button>`;
        } else if (user.requestPending) {
            if (user.requestType === 'outgoing') {
                actionButton = `<button class="add-friend-btn" disabled><i class="fas fa-clock"></i> Pending</button>`;
            } else {
                actionButton = `<button class="add-friend-btn" onclick="acceptFriendRequest('${user.requestId}')"><i class="fas fa-check"></i> Accept</button>`;
            }
        } else {
            actionButton = `<button class="add-friend-btn" onclick="sendFriendRequest('${user.userId}', '${user.name}')"><i class="fas fa-user-plus"></i> Add Friend</button>`;
        }
        
        div.innerHTML = `
            <div class="user-avatar-small">
                ${user.profilePic ? `<img src="${user.profilePic}">` : '<i class="fas fa-user"></i>'}
            </div>
            <div class="user-info">
                <div class="user-name">${user.name}</div>
                <div class="user-status">${user.userId}</div>
            </div>
            ${actionButton}
        `;
        
        container.appendChild(div);
    });
}

function sendFriendRequest(toUserId, toName) {
    if (!currentUser) return;
    
    socket.emit('send-friend-request', {
        fromUserId: currentUser.userId,
        fromName: currentUser.name,
        toUserId: toUserId
    });
}

function acceptFriendRequest(requestId) {
    socket.emit('accept-friend-request', {
        requestId,
        userId: currentUser.userId
    });
}

function rejectFriendRequest(requestId) {
    if (!confirm('Reject this friend request?')) return;
    
    socket.emit('reject-friend-request', {
        requestId,
        userId: currentUser.userId
    });
}

function cancelFriendRequest(requestId) {
    if (!confirm('Cancel this friend request?')) return;
    
    socket.emit('cancel-friend-request', {
        requestId,
        userId: currentUser.userId
    });
}

function unfriend(friendId) {
    if (!confirm('Remove this friend?')) return;
    
    socket.emit('unfriend', {
        userId: currentUser.userId,
        friendId: friendId
    });
}

function searchUsersToAdd() {
    const query = document.getElementById('find-users-search').value.trim();
    
    if (query.length < 2) {
        document.getElementById('find-users-results').innerHTML = '<div class="no-data">Type at least 2 characters</div>';
        return;
    }
    
    socket.emit('search-users-to-add', {
        query,
        userId: currentUser.userId
    });
}

function startChatWithFriend(friend) {
    // Check if user exists in users list
    if (!document.getElementById(`user-${friend.userId}`)) {
        addUserToList({ 
            userId: friend.userId, 
            name: friend.name, 
            profilePic: friend.profilePic, 
            online: friend.online 
        });
    }
    
    // Switch to chats panel and select user
    showChatPanel();
    selectUser(friend);
}

function canChatWithUser(userId) {
    // Can chat if user is yourself or friend
    return userId === currentUser?.userId || (friends.has(userId));
}

// ========== GROUP FUNCTIONS ==========
function showCreateGroupModal() {
    document.getElementById('create-group-modal').style.display = 'flex';
    loadAllUsersForGroup();
}

function closeCreateGroupModal() {
    document.getElementById('create-group-modal').style.display = 'none';
    document.getElementById('group-name').value = '';
    document.getElementById('group-description').value = '';
    document.getElementById('member-search').value = '';
    selectedMembers.clear();
    updateSelectedCount();
}

function loadAllUsersForGroup() {
    const membersList = document.getElementById('members-list');
    membersList.innerHTML = '';
    
    allUsers.forEach(user => {
        if (user.userId !== currentUser?.userId) {
            const memberDiv = createMemberElement(user);
            membersList.appendChild(memberDiv);
        }
    });
}

function createMemberElement(user) {
    const div = document.createElement('div');
    div.className = 'member-item';
    div.id = `member-${user.userId}`;
    div.onclick = () => toggleMember(user);
    
    div.innerHTML = `
        <div class="member-avatar">
            ${user.profilePic ? `<img src="${user.profilePic}">` : '<i class="fas fa-user"></i>'}
        </div>
        <div class="member-info">
            <div class="member-name">${user.name}</div>
            <div class="member-id">${user.userId}</div>
        </div>
    `;
    
    return div;
}

function toggleMember(user) {
    const memberDiv = document.getElementById(`member-${user.userId}`);
    
    if (selectedMembers.has(user.userId)) {
        selectedMembers.delete(user.userId);
        memberDiv.classList.remove('selected');
    } else {
        selectedMembers.add(user.userId);
        memberDiv.classList.add('selected');
    }
    
    updateSelectedCount();
}

function updateSelectedCount() {
    document.getElementById('selected-count').textContent = selectedMembers.size;
    document.getElementById('create-group-btn').disabled = selectedMembers.size < 1;
}

function searchMembers() {
    const query = document.getElementById('member-search').value.toLowerCase();
    const members = document.querySelectorAll('.member-item');
    
    members.forEach(member => {
        const name = member.querySelector('.member-name').textContent.toLowerCase();
        const id = member.querySelector('.member-id').textContent.toLowerCase();
        
        if (name.includes(query) || id.includes(query)) {
            member.style.display = 'flex';
        } else {
            member.style.display = 'none';
        }
    });
}

function createGroup() {
    const name = document.getElementById('group-name').value.trim();
    const description = document.getElementById('group-description').value.trim();
    const type = document.querySelector('input[name="groupType"]:checked').value;
    
    if (!name) {
        showToast('Please enter group name', 'warning');
        return;
    }
    
    if (selectedMembers.size < 1) {
        showToast('Please select at least one member', 'warning');
        return;
    }
    
    const members = Array.from(selectedMembers);
    
    socket.emit('create-group', {
        name,
        description,
        members,
        type,
        createdBy: currentUser.userId,
        icon: null
    });
    
    closeCreateGroupModal();
    showToast('Group created successfully', 'success');
}

function loadMyGroups() {
    socket.emit('get-my-groups', { userId: currentUser?.userId });
}

function displayGroup(group) {
    currentGroup = group;
    selectedUser = null; // Clear user selection
    
    document.querySelectorAll('.group-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`group-${group.groupId}`)?.classList.add('active');
    
    document.getElementById('current-group-name').textContent = group.name;
    document.getElementById('group-members-count').innerHTML = `<i class="fas fa-user"></i> ${group.members} members`;
    
    // Set group avatar
    const groupAvatar = document.getElementById('group-avatar');
    if (group.icon) {
        groupAvatar.innerHTML = `<img src="${group.icon}" alt="Group">`;
    } else {
        groupAvatar.innerHTML = '<i class="fas fa-users"></i>';
    }
    
    loadGroupMessages(group.groupId);
}

function loadGroupMessages(groupId) {
    socket.emit('get-group-messages', { groupId, userId: currentUser?.userId });
}

function displayGroupMessage(data) {
    const container = document.getElementById('group-messages-container');
    
    if (document.getElementById(`group-msg-${data.messageId}`)) return;
    
    const div = document.createElement('div');
    const isSent = data.fromUserId === currentUser?.userId;
    div.className = `group-message ${isSent ? 'sent' : 'received'}`;
    div.id = `group-msg-${data.messageId}`;
    
    const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Admin badge for admins
    const adminBadge = data.isSenderAdmin ? ' <span class="admin-badge" style="font-size: 10px; background: #667eea; color: white; padding: 2px 5px; border-radius: 10px; margin-left: 5px;">👑 Admin</span>' : '';
    
    let replyHtml = '';
    if (data.replyTo) {
        replyHtml = `
            <div class="replied-message">
                <div class="replied-sender">${data.replyTo.senderName}</div>
                <div class="replied-content">${data.replyTo.message}</div>
            </div>
        `;
    }
    
    div.innerHTML = `
        ${!isSent ? `<div class="sender-name">${data.fromName}${adminBadge}</div>` : ''}
        ${replyHtml}
        <div class="message-content">${data.message}</div>
        <div class="message-time">${time}</div>
    `;
    
    container.appendChild(div);
    
    if (data.reactions) {
        // Add reactions display for groups (can be added later)
    }
    
    container.scrollTop = container.scrollHeight;
}

function sendGroupMessage() {
    const input = document.getElementById('group-message-input');
    const msg = input.value.trim();
    
    if (!msg || !currentGroup) {
        if (!currentGroup) showToast('Select a group first', 'info');
        return;
    }
    
    const messageId = 'grp_msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const timestamp = new Date().toISOString();
    
    const messageData = {
        messageId,
        fromUserId: currentUser.userId,
        fromName: currentUser.name,
        message: msg,
        timestamp,
        replyTo: null
    };
    
    displayGroupMessage(messageData);
    
    socket.emit('group-message', {
        groupId: currentGroup.groupId,
        message: msg,
        fromUserId: currentUser.userId,
        fromName: currentUser.name,
        messageId: messageId,
        timestamp: timestamp,
        replyTo: null
    });
    
    input.value = '';
}

function handleGroupKeyPress(e) {
    if (e.key === 'Enter') {
        sendGroupMessage();
    }
}

// ========== GROUP INFO FUNCTIONS ==========
function showGroupInfo() {
    if (!currentGroup) return;
    
    socket.emit('get-group-info', {
        groupId: currentGroup.groupId,
        userId: currentUser.userId
    });
}

function closeGroupInfoModal() {
    document.getElementById('group-info-modal').style.display = 'none';
}

function displayGroupInfo(data) {
    document.getElementById('group-info-name').textContent = data.name;
    document.getElementById('group-info-description').textContent = data.description || 'No description';
    document.getElementById('group-total-members').textContent = data.totalMembers;
    document.getElementById('group-total-messages').textContent = data.totalMessages;
    
    const createdDate = new Date(data.createdAt).toLocaleDateString();
    document.getElementById('group-created-date').textContent = createdDate;
    
    // Set avatar
    const avatarDiv = document.getElementById('group-info-avatar');
    if (data.icon) {
        avatarDiv.innerHTML = `<img src="${data.icon}" alt="Group">`;
    } else {
        avatarDiv.innerHTML = '<i class="fas fa-users"></i>';
    }
    
    // Display members list
    const membersList = document.getElementById('group-members-list');
    membersList.innerHTML = '';
    
    data.members.forEach(member => {
        const memberDiv = document.createElement('div');
        memberDiv.className = 'group-member-item';
        
        let badges = '';
        if (member.isCreator) {
            badges += ' <span class="admin-badge" style="background: #ff9800;">👑 Creator</span>';
        } else if (member.isAdmin) {
            badges += ' <span class="admin-badge">👑 Admin</span>';
        }
        
        // Add make admin button if current user is admin and member is not admin/creator
        if (data.isCurrentUserAdmin && !member.isAdmin && !member.isCreator) {
            badges += ` <button onclick="makeGroupAdmin('${member.userId}')" class="make-admin-btn" style="margin-left: 10px; background: #667eea; color: white; border: none; padding: 2px 8px; border-radius: 12px; cursor: pointer;">Make Admin</button>`;
        }
        
        // Remove member button for admins
        if (data.isCurrentUserAdmin && !member.isCreator && member.userId !== currentUser.userId) {
            badges += ` <button onclick="removeGroupMember('${member.userId}')" class="remove-member-btn" style="margin-left: 5px; background: #ff4444; color: white; border: none; padding: 2px 8px; border-radius: 12px; cursor: pointer;">Remove</button>`;
        }
        
        memberDiv.innerHTML = `
            <div class="member-avatar">
                ${member.profilePic ? `<img src="${member.profilePic}">` : '<i class="fas fa-user"></i>'}
            </div>
            <div class="member-info">
                <div class="member-name">${member.name} ${badges}</div>
                <div class="member-id">${member.userId}</div>
            </div>
        `;
        
        membersList.appendChild(memberDiv);
    });
    
    document.getElementById('group-info-modal').style.display = 'flex';
}

// ========== GROUP ADMIN FUNCTIONS ==========
function makeGroupAdmin(memberId) {
    if (!currentGroup || !currentUser) return;
    
    if (!confirm('Make this user an admin?')) return;
    
    socket.emit('make-group-admin', {
        groupId: currentGroup.groupId,
        memberId: memberId,
        madeBy: currentUser.userId
    });
}

function removeGroupMember(memberId) {
    if (!currentGroup || !currentUser) return;
    
    if (!confirm('Remove this member from group?')) return;
    
    socket.emit('remove-group-member', {
        groupId: currentGroup.groupId,
        memberId: memberId,
        removedBy: currentUser.userId
    });
}

function leaveGroup() {
    if (!currentGroup || !currentUser) return;
    
    if (!confirm(`Leave group "${currentGroup.name}"?`)) return;
    
    socket.emit('leave-group', {
        groupId: currentGroup.groupId,
        userId: currentUser.userId
    });
}

function uploadGroupIcon() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const res = await fetch('/upload', { method: 'POST', body: formData });
            const data = await res.json();
            
            document.getElementById('group-icon-preview').innerHTML = `<img src="${data.fileUrl}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
            // Store icon URL for group creation
            window.groupIcon = data.fileUrl;
            
        } catch (error) {
            showToast('Failed to upload icon', 'error');
        }
    };
    input.click();
}

// ========== Socket event handlers ==========
socket.on('connect', () => {
    console.log('✅ Connected to server');
    if (currentUser) socket.emit('user-login', currentUser);
});

socket.on('connect_error', (error) => {
    console.log('❌ Connection error:', error);
    showToast('Connection error. Please refresh.', 'error');
});

socket.on('all-users', (users) => {
    console.log('📋 All users received:', users.length);
    allUsers = users;
});

socket.on('search-results', (users) => {
    displaySearchResults(users);
});

socket.on('username-check-result', (exists) => {
    if (exists) {
        showToast('This username is already used on another device!', 'error');
        document.getElementById('login-name').value = '';
        document.getElementById('login-name').focus();
        pendingLogin = false;
    } else {
        completeLogin();
    }
});

socket.on('login-error', (message) => {
    showToast(message, 'error');
    pendingLogin = false;
    localStorage.removeItem('hj-user-data');
    localStorage.removeItem('hj-device-user-id');
    document.getElementById('login-name').value = '';
    document.getElementById('profile-pic').innerHTML = '<i class="fas fa-camera"></i>';
});

// Online users handler
socket.on('online-users', (users) => {
    console.log('📋 Online users:', users);
    
    const onlineList = document.getElementById('online-users-list');
    const offlineList = document.getElementById('offline-users-list');
    
    if (!onlineList || !offlineList) return;
    
    onlineList.innerHTML = '';
    offlineList.innerHTML = '';
    
    const onlineUserIds = new Set(users.map(u => u.userId));
    
    if (allUsers.length > 0) {
        allUsers.forEach(user => {
            if (user.userId !== currentUser?.userId) {
                user.online = onlineUserIds.has(user.userId);
                addUserToList(user);
            }
        });
    } else {
        users.forEach(user => {
            if (user.userId !== currentUser?.userId) {
                user.online = true;
                addUserToList(user);
            }
        });
    }
});

socket.on('user-online', (user) => {
    console.log('🟢 User online:', user);
    
    const existingUser = allUsers.find(u => u.userId === user.userId);
    if (existingUser) {
        existingUser.online = true;
    } else {
        allUsers.push({ ...user, online: true });
    }
    
    updateUserStatus(user.userId, true);
    deliverQueuedMessages(user.userId);
    if (searchActive) performGlobalSearch();
    
    // Update friend status if friend
    if (friends.has(user.userId)) {
        const friend = friends.get(user.userId);
        friend.online = true;
        friends.set(user.userId, friend);
        if (document.getElementById('friends-panel').style.display === 'block') {
            loadMyFriends();
        }
    }
});

socket.on('user-offline', (user) => {
    console.log('🔴 User offline:', user);
    
    const existingUser = allUsers.find(u => u.userId === user.userId);
    if (existingUser) {
        existingUser.online = false;
    }
    
    updateUserStatus(user.userId, false);
    if (selectedUser?.userId === user.userId) {
        document.getElementById('chat-with-status').innerHTML = '<i class="fas fa-circle" style="color:#f44336;"></i> Offline';
    }
    if (searchActive) performGlobalSearch();
    
    // Update friend status if friend
    if (friends.has(user.userId)) {
        const friend = friends.get(user.userId);
        friend.online = false;
        friends.set(user.userId, friend);
        if (document.getElementById('friends-panel').style.display === 'block') {
            loadMyFriends();
        }
    }
});

socket.on('profile-updated', (data) => {
    const userItem = document.getElementById(`user-${data.userId}`);
    if (userItem) {
        const avatar = userItem.querySelector('.user-avatar');
        if (avatar) {
            avatar.innerHTML = data.profilePic ? `<img src="${data.profilePic}" alt="Profile">` : '<i class="fas fa-user-circle"></i>';
        }
    }
    
    // Update in friends list
    if (friends.has(data.userId)) {
        const friend = friends.get(data.userId);
        friend.profilePic = data.profilePic;
        friends.set(data.userId, friend);
    }
});

// Message reaction handler
socket.on('message-reaction', (data) => {
    if (!selectedUser || selectedUser.userId !== data.fromUserId) return;
    
    const history = loadChatHistory(selectedUser.userId);
    const msgIndex = history.findIndex(m => m.messageId === data.messageId);
    
    if (msgIndex !== -1) {
        history[msgIndex].reactions = data.reactions;
        const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
        localStorage.setItem(key, JSON.stringify(history));
        
        updateMessageReactions(data.messageId, data.reactions);
    }
});

// Private message handler
socket.on('private-message', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    
    const timestamp = data.timestamp || new Date().toISOString();
    
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        displayMessage(data.fromName, data.message, 'received', timestamp, data.messageId, { 
            fromName: data.fromName,
            fromUserId: data.fromUserId,
            messageId: data.messageId,
            replyTo: data.replyTo
        });
        
        saveMessageToHistory(data.fromUserId, { 
            fromName: data.fromName, 
            message: data.message, 
            timestamp: timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true,
            replyTo: data.replyTo,
            reactions: []
        });
        
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
        
    } else {
        if (!currentUser) return;
        
        const key = `chat_${currentUser.userId}_${data.fromUserId}`;
        const history = loadChatHistory(data.fromUserId);
        history.push({ 
            fromName: data.fromName, 
            message: data.message, 
            timestamp: timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true,
            replyTo: data.replyTo,
            reactions: []
        });
        localStorage.setItem(key, JSON.stringify(history));
        
        const userEl = document.getElementById(`user-${data.fromUserId}`);
        if (userEl) {
            userEl.style.backgroundColor = '#fff3cd';
            setTimeout(() => userEl.style.backgroundColor = '', 2000);
            
            const unreadCount = history.filter(msg => msg.fromName !== 'You' && !msg.read).length;
            
            const h4 = userEl.querySelector('h4');
            if (h4) {
                const existingBadge = h4.querySelector('.unread-badge');
                if (existingBadge) existingBadge.remove();
                if (unreadCount > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'unread-badge';
                    badge.style.cssText = 'background:#ff4444;color:white;padding:2px 6px;border-radius:10px;font-size:10px;margin-left:5px;';
                    badge.textContent = unreadCount;
                    h4.appendChild(badge);
                }
            }
        }
        
        showNotification(`New message from ${data.fromName}`, { 
            body: data.message, 
            userId: data.fromUserId 
        });
    }
});

// Message read receipt handler
socket.on('message-read', (data) => {
    const { messageId, fromUserId } = data;
    
    const messageEl = document.getElementById(`msg-${messageId}`);
    if (messageEl) {
        const timeEl = messageEl.querySelector('.time');
        if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
            timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
        }
    }
    
    if (selectedUser) {
        updateMessageInHistory(selectedUser.userId, messageId, { read: true, readAt: new Date().toISOString() });
    }
});

// All messages read handler
socket.on('messages-read', (data) => {
    const { fromUserId } = data;
    
    if (selectedUser && selectedUser.userId === fromUserId) {
        const messages = document.querySelectorAll('.message.sent');
        messages.forEach(msg => {
            const timeEl = msg.querySelector('.time');
            if (timeEl && !timeEl.innerHTML.includes('✓✓')) {
                timeEl.innerHTML = timeEl.innerHTML + ' <span class="read-receipt"><i class="fas fa-check-double" style="color: #4fc3f7;"></i></span>';
            }
        });
    }
});

socket.on('voice-message', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        displayVoiceMessage(data);
        saveMessageToHistory(data.fromUserId, { 
            fromName: data.fromName, 
            type: 'voice', 
            audioUrl: data.audioUrl, 
            duration: data.duration, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true,
            reactions: []
        });
        
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
        
    } else if (currentUser) {
        const key = `chat_${currentUser.userId}_${data.fromUserId}`;
        const history = loadChatHistory(data.fromUserId);
        history.push({ 
            fromName: data.fromName, 
            type: 'voice', 
            audioUrl: data.audioUrl, 
            duration: data.duration, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true,
            reactions: []
        });
        localStorage.setItem(key, JSON.stringify(history));
    }
});

socket.on('file-message', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        displayFileMessage(data);
        saveMessageToHistory(data.fromUserId, { 
            fromName: data.fromName, 
            type: 'file', 
            fileUrl: data.fileUrl, 
            fileName: data.fileName, 
            fileType: data.fileType, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true,
            reactions: []
        });
        
        setTimeout(() => {
            markMessageAsRead(data.messageId, data.fromUserId);
        }, 1000);
        
    } else if (currentUser) {
        const key = `chat_${currentUser.userId}_${data.fromUserId}`;
        const history = loadChatHistory(data.fromUserId);
        history.push({ 
            fromName: data.fromName, 
            type: 'file', 
            fileUrl: data.fileUrl, 
            fileName: data.fileName, 
            fileType: data.fileType, 
            timestamp: data.timestamp,
            messageId: data.messageId,
            deletedFor: [],
            deletedForEveryone: false,
            read: false,
            delivered: true,
            reactions: []
        });
        localStorage.setItem(key, JSON.stringify(history));
    }
});

// Delete message handler
socket.on('message-deleted', (data) => {
    if (!selectedUser) return;
    
    if (data.deleteType === 'for-everyone') {
        const messageEl = document.getElementById(`msg-${data.messageId}`);
        if (messageEl) {
            const timeElement = messageEl.querySelector('.time');
            const timeText = timeElement ? timeElement.textContent : '';
            
            messageEl.innerHTML = `
                <div class="deleted-message">
                    <i class="fas fa-trash"></i> This message was deleted
                </div>
                <div class="time">${timeText}</div>
            `;
            messageEl.classList.add('deleted');
        }
        
        const history = loadChatHistory(selectedUser.userId);
        const msgIndex = history.findIndex(m => m.messageId === data.messageId);
        if (msgIndex !== -1) {
            history[msgIndex].deletedForEveryone = true;
            const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
            localStorage.setItem(key, JSON.stringify(history));
        }
    }
    else if (data.deleteType === 'for-me' && data.fromUserId === currentUser?.userId) {
        const messageEl = document.getElementById(`msg-${data.messageId}`);
        if (messageEl) messageEl.remove();
        
        const history = loadChatHistory(selectedUser.userId);
        const msgIndex = history.findIndex(m => m.messageId === data.messageId);
        if (msgIndex !== -1) {
            if (!history[msgIndex].deletedFor) {
                history[msgIndex].deletedFor = [];
            }
            if (!history[msgIndex].deletedFor.includes(currentUser.userId)) {
                history[msgIndex].deletedFor.push(currentUser.userId);
            }
            const key = `chat_${currentUser.userId}_${selectedUser.userId}`;
            localStorage.setItem(key, JSON.stringify(history));
        }
    }
});

socket.on('typing-indicator', (data) => {
    if (blockedUsers.includes(data.fromUserId)) return;
    if (selectedUser && selectedUser.userId === data.fromUserId) {
        const status = document.getElementById('chat-with-status');
        status.innerHTML = data.isTyping ? '<i class="fas fa-pencil-alt"></i> typing...' : '<i class="fas fa-circle" style="color:#4caf50;"></i> Online';
    }
});

// ========== FRIEND REQUEST SOCKET HANDLERS ==========

// New friend request received
socket.on('new-friend-request', (data) => {
    showToast(`📨 New friend request from ${data.fromName}`, 'info');
    playNotificationSound();
    
    // Update pending requests if on friends panel
    if (document.getElementById('friends-panel').style.display === 'block') {
        loadPendingRequests();
    }
    
    // Update badge count
    const badge = document.getElementById('pending-requests-count');
    badge.textContent = parseInt(badge.textContent) + 1;
});

// Friend request sent
socket.on('friend-request-sent', (data) => {
    showToast(`Friend request sent to ${data.toName}`, 'success');
    
    // Update UI
    if (document.getElementById('friends-panel').style.display === 'block') {
        loadPendingRequests();
        searchUsersToAdd(); // Refresh search results
    }
});

// Friend request accepted
socket.on('friend-request-accepted', (data) => {
    showToast(`🎉 You are now friends with ${data.friendName}!`, 'success');
    
    // Add to friends list
    friends.set(data.friendId, {
        userId: data.friendId,
        name: data.friendName,
        profilePic: data.friendProfilePic,
        online: true
    });
    
    // Refresh friends list
    loadMyFriends();
    loadPendingRequests();
    
    // Refresh search if open
    if (document.getElementById('find-users-search').value.length >= 2) {
        searchUsersToAdd();
    }
});

// Friend request rejected
socket.on('friend-request-rejected', (data) => {
    showToast('Friend request was rejected', 'info');
    
    // Update UI
    loadPendingRequests();
    if (document.getElementById('find-users-search').value.length >= 2) {
        searchUsersToAdd();
    }
});

// Friend request cancelled
socket.on('friend-request-cancelled', (data) => {
    showToast('Friend request was cancelled', 'info');
    
    // Update UI
    loadPendingRequests();
    if (document.getElementById('find-users-search').value.length >= 2) {
        searchUsersToAdd();
    }
});

// My friends list
socket.on('my-friends', (friendsList) => {
    displayMyFriends(friendsList);
});

// Pending requests list
socket.on('pending-requests', (requests) => {
    displayPendingRequests(requests);
});

// User search results
socket.on('users-search-results', (users) => {
    displayUserSearchResults(users);
});

// Unfriended
socket.on('unfriended', (data) => {
    showToast('Friend removed', 'info');
    
    // Remove from friends map
    friends.delete(data.userId);
    
    // Refresh lists
    loadMyFriends();
    
    // If currently chatting with this user, go back to friends panel
    if (selectedUser && selectedUser.userId === data.userId) {
        selectedUser = null;
        document.getElementById('no-chat-selected').classList.remove('hidden');
        document.getElementById('chat-with-name').textContent = 'Select Contact';
        document.getElementById('messages-container').innerHTML = '';
    }
});

// Error handler
socket.on('error', (message) => {
    showToast(message, 'error');
});

// ========== GROUP SOCKET HANDLERS ==========

// Group created
socket.on('group-created', (data) => {
    showToast(`New group "${data.name}" created`, 'success');
    loadMyGroups();
});

socket.on('group-created-success', (data) => {
    console.log('Group created:', data);
});

// My groups list
socket.on('my-groups', (groups) => {
    const groupsList = document.getElementById('my-groups-list');
    groupsList.innerHTML = '';
    
    if (groups.length === 0) {
        groupsList.innerHTML = '<div class="no-users">No groups yet. Create one!</div>';
        return;
    }
    
    myGroups.clear();
    
    groups.forEach(group => {
        myGroups.set(group.groupId, group);
        
        const groupDiv = document.createElement('div');
        groupDiv.className = 'group-item';
        groupDiv.id = `group-${group.groupId}`;
        groupDiv.onclick = () => displayGroup(group);
        
        const lastMessage = group.lastMessage ? 
            group.lastMessage.message.substring(0, 20) + '...' : 
            'No messages yet';
        
        const adminBadge = group.isAdmin ? ' <span class="group-badge" style="background: #667eea;">Admin</span>' : '';
        
        groupDiv.innerHTML = `
            <div class="group-avatar">
                ${group.icon ? `<img src="${group.icon}" alt="Group">` : '<i class="fas fa-users"></i>'}
            </div>
            <div class="group-info">
                <h4>${group.name}${adminBadge}</h4>
                <p>${group.members} members • ${lastMessage}</p>
            </div>
        `;
        
        groupsList.appendChild(groupDiv);
    });
});

// Group messages
socket.on('group-messages', (data) => {
    const container = document.getElementById('group-messages-container');
    container.innerHTML = '';
    
    data.messages.forEach(msg => {
        displayGroupMessage(msg);
    });
});

// New group message
socket.on('group-message', (data) => {
    if (currentGroup && currentGroup.groupId === data.groupId) {
        displayGroupMessage(data);
    }
});

// Group admin made
socket.on('group-admin-made', (data) => {
    showToast(data.message, 'success');
    if (currentGroup && currentGroup.groupId === data.groupId) {
        // Refresh group info
        showGroupInfo();
    }
});

socket.on('group-admin-made-success', (data) => {
    showToast(`${data.memberName} is now an admin`, 'success');
});

// Group admin removed
socket.on('group-admin-removed', (data) => {
    showToast(data.message, 'info');
    if (currentGroup && currentGroup.groupId === data.groupId) {
        showGroupInfo();
    }
});

// Group member added
socket.on('group-member-added', (data) => {
    showToast(data.message, 'success');
    if (currentGroup && currentGroup.groupId === data.groupId) {
        document.getElementById('group-members-count').innerHTML = `<i class="fas fa-user"></i> ${data.members.length} members`;
    }
    loadMyGroups();
});

// Group member removed
socket.on('group-member-removed', (data) => {
    showToast(data.message, 'info');
    if (currentGroup && currentGroup.groupId === data.groupId) {
        if (data.memberId === currentUser?.userId) {
            // Current user was removed
            showChatPanel();
            showToast(`You were removed from ${data.groupName}`, 'warning');
        } else {
            document.getElementById('group-members-count').innerHTML = `<i class="fas fa-user"></i> ${data.members.length} members`;
        }
    }
    loadMyGroups();
});

// Group member left
socket.on('group-member-left', (data) => {
    showToast(data.message, 'info');
    if (currentGroup && currentGroup.groupId === data.groupId) {
        document.getElementById('group-members-count').innerHTML = `<i class="fas fa-user"></i> ${data.members.length} members`;
    }
    loadMyGroups();
});

// Removed from group
socket.on('removed-from-group', (data) => {
    showToast(data.message, 'error');
    showChatPanel();
    loadMyGroups();
});

// Left group
socket.on('left-group', (data) => {
    showToast(`You left ${data.groupName}`, 'info');
    showChatPanel();
    loadMyGroups();
});

// Group deleted
socket.on('group-deleted', (data) => {
    showToast(data.message, 'error');
    showChatPanel();
    loadMyGroups();
});

// Group info response
socket.on('group-info', (data) => {
    displayGroupInfo(data);
});

// Group settings updated
socket.on('group-settings-updated', (data) => {
    showToast(data.message, 'info');
    if (currentGroup && currentGroup.groupId === data.groupId) {
        // Update settings
    }
});

// Group ownership transferred
socket.on('group-ownership-transferred', (data) => {
    showToast(data.message, 'success');
    if (currentGroup && currentGroup.groupId === data.groupId) {
        showGroupInfo();
    }
    loadMyGroups();
});

// Call handlers
socket.on('call-offer', async (data) => {
    console.log('📞 Incoming call:', data);
    
    if (callActive) {
        socket.emit('call-busy', { toUserId: data.fromUserId });
        return;
    }
    
    pendingCall = {
        fromUserId: data.fromUserId,
        fromName: data.fromName,
        offer: data.offer,
        callType: data.callType
    };
    
    const callDialog = document.createElement('div');
    callDialog.className = 'call-dialog incoming';
    callDialog.id = 'incoming-call';
    callDialog.innerHTML = `
        <div class="call-dialog-content">
            <h3>Incoming ${data.callType} Call</h3>
            <p>${data.fromName} is calling...</p>
            <div class="call-buttons">
                <button onclick="acceptCall()" class="accept-call-btn"><i class="fas fa-phone"></i> Accept</button>
                <button onclick="rejectCall()" class="reject-call-btn"><i class="fas fa-phone-slash"></i> Reject</button>
            </div>
        </div>
    `;
    document.body.appendChild(callDialog);
    
    showNotification(`Incoming ${data.callType} call from ${data.fromName}`, { 
        userId: data.fromUserId, 
        body: 'Tap to answer' 
    });
});

// Accept call
window.acceptCall = async function() {
    document.getElementById('incoming-call')?.remove();
    
    if (!pendingCall) {
        showToast('No incoming call', 'error');
        return;
    }
    
    try {
        callType = pendingCall.callType;
        
        const constraints = { 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 2,
                sampleRate: 48000
            }
        };
        
        if (pendingCall.callType === 'video') {
            constraints.video = {
                width: { ideal: 640, min: 320 },
                height: { ideal: 480, min: 240 },
                facingMode: 'user',
                frameRate: { ideal: 20, min: 10 }
            };
        }
        
        showToast('Accepting call...', 'info');
        
        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            console.log('Local stream obtained for accepting call');
        } catch (err) {
            console.error('Media device error:', err);
            showToast('Failed to access media devices', 'error');
            return;
        }
        
        peerConnection = new RTCPeerConnection({
            iceServers: configuration.iceServers,
            iceCandidatePoolSize: 10,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        
        localStream.getTracks().forEach(track => {
            console.log('Adding track:', track.kind);
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            console.log('Received remote track:', event.track.kind);
            if (!remoteStream) {
                remoteStream = new MediaStream();
            }
            remoteStream.addTrack(event.track);
            
            showCallScreen(pendingCall.callType);
            
            setTimeout(() => {
                if (pendingCall.callType === 'video') {
                    const remoteVideo = document.getElementById('remote-video');
                    if (remoteVideo) {
                        remoteVideo.srcObject = remoteStream;
                        remoteVideo.play().catch(e => console.log('Remote video play error:', e));
                    }
                } else {
                    const audio = new Audio();
                    audio.srcObject = remoteStream;
                    audio.play().catch(e => console.log('Audio play error:', e));
                }
            }, 500);
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', { 
                    toUserId: pendingCall.fromUserId, 
                    candidate: event.candidate,
                    fromUserId: currentUser.userId
                });
            }
        };
        
        peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                callStartTime = Date.now();
                startCallTimer();
            } else if (peerConnection.connectionState === 'disconnected' || 
                       peerConnection.connectionState === 'failed') {
                showToast('Call disconnected', 'warning');
                endCall();
            }
        };
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingCall.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('call-answer', { 
            toUserId: pendingCall.fromUserId, 
            answer: answer,
            fromUserId: currentUser.userId
        });
        
        callActive = true;
        
    } catch (error) {
        console.error('Accept call error:', error);
        showToast('Failed to accept call: ' + error.message, 'error');
        endCall();
    }
};

window.rejectCall = function() {
    document.getElementById('incoming-call')?.remove();
    socket.emit('call-end', { 
        toUserId: pendingCall.fromUserId, 
        fromUserId: currentUser.userId 
    });
    pendingCall = null;
};

// Call answer handler
socket.on('call-answer', async (data) => {
    console.log('Call answer received');
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            document.getElementById('call-dialog')?.remove();
            console.log('Remote description set successfully');
        } catch (error) {
            console.error('Error setting remote description:', error);
            showToast('Call connection failed', 'error');
            endCall();
        }
    }
});

// ICE candidate handler
socket.on('ice-candidate', async (data) => {
    console.log('ICE candidate received');
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            console.log('ICE candidate added');
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }
});

socket.on('call-end', () => {
    endCall();
    showToast('Call ended', 'info');
});

socket.on('call-busy', () => {
    endCall();
    showToast('User is busy', 'warning');
});

socket.on('message-queued', () => {
    showToast('Message queued - user is offline', 'info');
});

socket.on('last-seen-update', (data) => {
    const userItem = document.getElementById(`user-${data.userId}`);
    if (userItem && data.userId !== currentUser?.userId) {
        const statusEl = userItem.querySelector('.user-info p');
        statusEl.innerHTML = `<i class="fas fa-circle" style="color:#999;"></i> ${getLastSeenText(data.timestamp)}`;
    }
});

// Click anywhere to close delete menu and reaction picker
document.addEventListener('click', (e) => {
    if (!e.target.closest('.message-delete-btn') && !e.target.closest('.delete-menu')) {
        closeDeleteMenu();
    }
    if (!e.target.closest('.message-reaction-btn') && !e.target.closest('.reaction-picker')) {
        if (activeReactionPicker) {
            activeReactionPicker.remove();
            activeReactionPicker = null;
        }
    }
});

// ========== Initialize on load ==========
window.addEventListener('load', async () => {
    await requestNotificationPermission();
    loadMessageQueue();
    
    initTheme();
    
    const uniqueId = await generateUniqueUserId();
    document.getElementById('login-userid').value = uniqueId;
    
    const userData = loadUserData();
    if (userData && userData.userId === uniqueId) {
        document.getElementById('login-name').value = userData.name || '';
        if (userData.profilePic) {
            setTimeout(() => {
                const profilePicDiv = document.getElementById('profile-pic');
                if (profilePicDiv) profilePicDiv.innerHTML = `<img src="${userData.profilePic}" alt="Profile">`;
            }, 1000);
        }
        setTimeout(() => login(), 500);
    }
    
    const blocked = localStorage.getItem('hj-blocked-users');
    if (blocked) blockedUsers = JSON.parse(blocked);
});

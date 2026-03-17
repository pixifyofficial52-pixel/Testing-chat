// Minimal script.js for testing
console.log('✅ script.js loaded');

const socket = io({
    secure: true,
    reconnection: true
});

socket.on('connect', () => {
    console.log('✅ Socket connected:', socket.id);
});

socket.on('connect_error', (err) => {
    console.error('❌ Socket error:', err);
});

// Login function
function login() {
    console.log('Login clicked');
    const name = document.getElementById('login-name').value;
    const id = document.getElementById('login-userid').value;
    
    if (!name || !id) {
        alert('Please enter name');
        return;
    }
    
    // Hide login, show chat
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('chat-screen').classList.add('active');
    document.getElementById('current-user-name').textContent = name;
    document.getElementById('current-user-id').textContent = id;
}

// Generate ID on load
window.addEventListener('load', () => {
    console.log('Page loaded');
    const id = 'user_' + Date.now();
    document.getElementById('login-userid').value = id;
});

// Dummy functions to prevent errors
function toggleSidebar() {}
function uploadProfilePicture() {}
function logout() {}
function showChatPanel() {}
function showFriendsPanel() {}
function showGroupPanel() {}
function sendFile() {}
function sendPhoto() {}
function startVideoCall() {}
function startVoiceCall() {}
function toggleGlobalSearch() {}
function toggleMessageSearch() {}
function sendMessage() {}
function handleKeyPress() {}
function cancelReply() {}
function startVoiceRecording() {}
function cancelRecording() {}
function sendVoiceMessage() {}
function searchUsersToAdd() {}
function showCreateGroupModal() {}
function closeCreateGroupModal() {}
function createGroup() {}
function searchMembers() {}
function showGroupInfo() {}
function closeGroupInfoModal() {}
function leaveGroup() {}
function uploadGroupIcon() {}
function toggleTheme() {}

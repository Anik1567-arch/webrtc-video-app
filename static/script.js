// DOM Elements
const lobbyContainer = document.getElementById('lobby-container');
const callContainer = document.getElementById('call-container');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const lobbyError = document.getElementById('lobby-error');
const statusBanner = document.getElementById('status-banner');

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const leaveBtn = document.getElementById('leave-btn');
const micIcon = document.getElementById('mic-icon');
const camIcon = document.getElementById('cam-icon');

// State Variables
let localStream = null;
let peerConnection = null;
let ws = null;
let iceCandidatesQueue = [];

// Public STUN servers (Google) to discover public IP & traverse NATs/routers
// Plus free OpenRelay TURN servers as a fallback for strict mobile carrier firewalls
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// 1. Join Room Event
joinBtn.addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    if (!roomId) {
        lobbyError.textContent = 'Please enter a valid Room Name!';
        return;
    }
    lobbyError.textContent = '';

    // Request Camera and Microphone permissions
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, facingMode: 'user' },
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        localVideo.srcObject = localStream;
    } catch (err) {
        console.error('Error accessing media devices:', err);
        lobbyError.textContent = 'Could not access camera/microphone. Please allow permissions and ensure you are on HTTPS.';
        return;
    }

    // Switch UI from Lobby to Call Screen
    lobbyContainer.classList.add('hidden');
    callContainer.classList.remove('hidden');

    // Connect to FastAPI WebSocket Signaling Server
    connectWebSocket(roomId);
});

// 2. Setup WebSocket Connection
function connectWebSocket(roomId) {
    // Automatically choose wss:// for HTTPS or ws:// for localhost
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/${encodeURIComponent(roomId)}`;
    
    ws = new WebSocket(wsUrl);

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'full') {
            alert('This room already has 2 participants! Please try a different room name.');
            endCall();
            return;
        }

        if (message.type === 'ready') {
            // Second user joined! The first user creates and sends the WebRTC Offer
            statusBanner.textContent = 'Friend joined! Connecting video...';
            await createPeerConnection();
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sendSignal({ type: 'offer', sdp: peerConnection.localDescription });
        }

        else if (message.type === 'offer') {
            // Second user receives the Offer, sets it, and responds with an Answer
            statusBanner.textContent = 'Connecting video...';
            await createPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
            
            // Process any ICE candidates that arrived before the remote description was set
            await processQueuedCandidates();

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            sendSignal({ type: 'answer', sdp: peerConnection.localDescription });
        }

        else if (message.type === 'answer') {
            // First user receives the Answer
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp));
            await processQueuedCandidates();
        }

        else if (message.type === 'candidate') {
            const candidate = new RTCIceCandidate(message.candidate);
            // Only add ICE candidate if remoteDescription is ready; otherwise queue it
            if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                await peerConnection.addIceCandidate(candidate);
            } else {
                iceCandidatesQueue.push(candidate);
            }
        }

        else if (message.type === 'peer-left') {
            statusBanner.textContent = 'Your friend left the call. Waiting for someone to join...';
            statusBanner.classList.remove('hidden');
            remoteVideo.srcObject = null;
            closePeerConnection();
        }
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// Helper to send JSON data through WebSocket
function sendSignal(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// 3. Create & Configure RTCPeerConnection
async function createPeerConnection() {
    closePeerConnection(); // Ensure clean state
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Add our local camera & mic tracks into the connection
    localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
    });

    // When our friend's video/audio tracks arrive, attach them to the remote <video> element
    peerConnection.ontrack = (event) => {
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            statusBanner.classList.add('hidden'); // Hide banner once video starts!
        }
    };

    // Whenever our browser finds a network path (ICE Candidate), send it to our friend
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal({ type: 'candidate', candidate: event.candidate });
        }
    };

    // Monitor connection state changes
    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
            statusBanner.classList.add('hidden');
        } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
            statusBanner.textContent = 'Connection lost or unstable...';
            statusBanner.classList.remove('hidden');
        }
    };
}

// Drain queued ICE candidates safely
async function processQueuedCandidates() {
    while (iceCandidatesQueue.length > 0) {
        const candidate = iceCandidatesQueue.shift();
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (e) {
            console.error('Failed to add queued ICE candidate:', e);
        }
    }
}

function closePeerConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    iceCandidatesQueue = [];
}

// 4. UI Button Controls (Mute, Camera Toggle, End Call)
micBtn.addEventListener('click', () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        micIcon.textContent = audioTrack.enabled ? '🎤 Mute' : '🔇 Unmute';
        micBtn.classList.toggle('muted-state', !audioTrack.enabled);
    }
});

camBtn.addEventListener('click', () => {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        camIcon.textContent = videoTrack.enabled ? '📷 Stop Video' : '🚫 Start Video';
        camBtn.classList.toggle('muted-state', !videoTrack.enabled);
    }
});

leaveBtn.addEventListener('click', () => {
    endCall();
});

function endCall() {
    closePeerConnection();

    if (ws) {
        ws.close();
        ws = null;
    }

    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    localVideo.srcObject = null;
    remoteVideo.srcObject = null;

    // Reset button states
    micIcon.textContent = '🎤 Mute';
    camIcon.textContent = '📷 Stop Video';
    micBtn.classList.remove('muted-state');
    camBtn.classList.remove('muted-state');
    statusBanner.textContent = 'Waiting for your friend to join...';
    statusBanner.classList.remove('hidden');

    // Return to Lobby
    callContainer.classList.add('hidden');
    lobbyContainer.classList.remove('hidden');
}
